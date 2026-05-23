import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BookingStatus,
  CalendarEntryKind,
  Prisma,
} from '@prisma/client';
import { GetCalendarEntriesDto } from './dto/get-calendar-entries.dto';
import { CreateBlockDto } from './dto/create-block.dto';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateCalendarEntryDto } from './dto/update-calendar-entry.dto';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { CacheService } from '../cache/cache.service';

const ENTRY_INCLUDE = {
  businessService: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      priceCents: true,
      currency: true,
    },
  },
  employee: {
    select: { id: true, firstName: true, lastName: true, avatarUrl: true },
  },
  requester: {
    select: { id: true, name: true },
  },
} satisfies Prisma.BookingInclude;

@Injectable()
export class CalendarService {
  constructor(
    private prisma: PrismaService,
    private wsGateway: WebsocketGateway,
    private cacheService: CacheService,
  ) {}

  private async invalidateBookingsCache(...userIds: (string | null | undefined)[]) {
    const unique = Array.from(new Set(userIds.filter((u): u is string => !!u)));
    await Promise.all(
      unique.map((id) => this.cacheService.delByPattern(`bookings:user:${id}:*`)),
    );
  }

  private async getBusinessId(userId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({
      where: { ownerId: userId },
      select: { id: true },
    });
    if (!business) throw new NotFoundException('Business non trouvé');
    return business.id;
  }

  async getEntries(userId: string, dto: GetCalendarEntriesDto) {
    const businessId = await this.getBusinessId(userId);
    const start = new Date(dto.start);
    const end = new Date(dto.end);
    const now = new Date();

    // Auto-complete expired appointments (single SQL query, runs lazily on each fetch)
    const autoCompleted = await this.prisma.booking.updateMany({
      where: {
        employee: { businessId },
        kind: CalendarEntryKind.APPOINTMENT,
        status: { in: [BookingStatus.ACCEPTED, BookingStatus.PENDING] },
        scheduledEndAt: { lt: now },
      },
      data: {
        status: BookingStatus.COMPLETED,
        completedAt: now,
      },
    });
    if (autoCompleted.count > 0) {
      // The provider's own bookings cache is stale; we don't track every
      // requester touched here, so the daily cron's wide pattern wipe will
      // catch the rest within its TTL.
      await this.invalidateBookingsCache(userId);
    }

    const where: Prisma.BookingWhereInput = {
      employee: { businessId },
      scheduledAt: { gte: start },
      scheduledEndAt: { lte: end },
      NOT: { status: BookingStatus.REJECTED },
      ...(dto.staffId && { employeeId: dto.staffId }),
    };

    return this.prisma.booking.findMany({
      where,
      include: ENTRY_INCLUDE,
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async createBlock(userId: string, dto: CreateBlockDto) {
    const businessId = await this.getBusinessId(userId);

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { businessId: true },
    });
    if (!employee || employee.businessId !== businessId) {
      throw new ForbiddenException('Accès refusé');
    }

    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt <= startAt) {
      throw new BadRequestException('La date de fin doit être après la date de début');
    }

    await this.assertNoOverlap(dto.employeeId, startAt, endAt, null);

    let block;
    try {
      block = await this.prisma.booking.create({
        data: {
          kind: CalendarEntryKind.BLOCK,
          status: BookingStatus.ACCEPTED,
          employeeId: dto.employeeId,
          providerId: userId,
          requesterId: userId,
          businessServiceId: null,
          scheduledAt: startAt,
          scheduledEndAt: endAt,
          blockReason: dto.blockReason,
          notes: dto.notes,
        },
        include: ENTRY_INCLUDE,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.meta as { code?: string } | undefined)?.code === '23P01'
      ) {
        throw new ConflictException('Conflit horaire pour cet employé');
      }
      throw e;
    }
    this.wsGateway.sendCalendarUpdate(userId);
    await this.invalidateBookingsCache(userId);
    return block;
  }

  async createAppointment(userId: string, dto: CreateAppointmentDto) {
    const businessId = await this.getBusinessId(userId);

    // Verify employee belongs to business
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { businessId: true },
    });
    if (!employee || employee.businessId !== businessId) {
      throw new ForbiddenException('Accès refusé');
    }

    // Verify service belongs to business
    const service = await this.prisma.businessService.findUnique({
      where: { id: dto.businessServiceId },
      select: { businessId: true, durationMinutes: true, priceCents: true },
    });
    if (!service || service.businessId !== businessId) {
      throw new BadRequestException('Service invalide');
    }

    const scheduledAt = new Date(dto.scheduledAt);
    const scheduledEndAt = new Date(
      scheduledAt.getTime() + service.durationMinutes * 60000,
    );

    await this.assertNoOverlap(dto.employeeId, scheduledAt, scheduledEndAt, null);

    // Determine requesterId: client if provided, otherwise business owner (walk-in)
    let requesterId = userId;
    if (dto.clientUserId) {
      const client = await this.prisma.businessClient.findUnique({
        where: {
          businessId_userId: { businessId, userId: dto.clientUserId },
        },
      });
      if (!client) {
        throw new BadRequestException('Client introuvable pour ce business');
      }
      requesterId = dto.clientUserId;
    }

    // Check auto-accept
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { autoAcceptBookings: true },
    });

    // Even with assertNoOverlap above, a concurrent insert can sneak between
    // the check and the create. The DB-level `booking_no_overlap` constraint
    // is the source of truth — we catch its violation and surface a 409.
    let appointment;
    try {
      appointment = await this.prisma.booking.create({
        data: {
          kind: CalendarEntryKind.APPOINTMENT,
          status: business?.autoAcceptBookings
            ? BookingStatus.ACCEPTED
            : BookingStatus.PENDING,
          employeeId: dto.employeeId,
          businessServiceId: dto.businessServiceId,
          providerId: userId,
          requesterId,
          scheduledAt,
          scheduledEndAt,
          agreedPriceCents: service.priceCents,
          notes: dto.notes,
        },
        include: ENTRY_INCLUDE,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.meta as { code?: string } | undefined)?.code === '23P01'
      ) {
        throw new ConflictException('Conflit horaire pour cet employé');
      }
      throw e;
    }
    this.wsGateway.sendCalendarUpdate(userId);
    await this.invalidateBookingsCache(userId, requesterId);
    return appointment;
  }

  async updateEntry(userId: string, entryId: string, dto: UpdateCalendarEntryDto) {
    const businessId = await this.getBusinessId(userId);

    const entry = await this.prisma.booking.findUnique({
      where: { id: entryId },
      include: { employee: { select: { businessId: true } } },
    });
    if (!entry) throw new NotFoundException('Entrée non trouvée');
    if (entry.employee.businessId !== businessId) {
      throw new ForbiddenException('Accès refusé');
    }

    // Optimistic locking
    if (dto.updatedAt && entry.updatedAt.toISOString() !== dto.updatedAt) {
      throw new ConflictException('Conflit de mise à jour — veuillez recharger');
    }

    const updateData: Prisma.BookingUpdateInput = {};

    // Staff reassign
    const targetEmployeeId = dto.employeeId || entry.employeeId;
    if (dto.employeeId && dto.employeeId !== entry.employeeId) {
      const newEmployee = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { businessId: true },
      });
      if (!newEmployee || newEmployee.businessId !== businessId) {
        throw new BadRequestException('Employé invalide');
      }
      updateData.employee = { connect: { id: dto.employeeId } };
    }

    // Time update
    const newStart = dto.startAt ? new Date(dto.startAt) : entry.scheduledAt;
    const newEnd = dto.endAt ? new Date(dto.endAt) : entry.scheduledEndAt;

    if (dto.startAt || dto.endAt || dto.employeeId) {
      await this.assertNoOverlap(targetEmployeeId, newStart!, newEnd!, entryId);
      if (dto.startAt) updateData.scheduledAt = newStart;
      if (dto.endAt) updateData.scheduledEndAt = newEnd;
    }

    // Status update
    if (dto.status) {
      updateData.status = dto.status;
      if (dto.status === BookingStatus.COMPLETED) {
        updateData.completedAt = new Date();
      }
    }

    let updated;
    try {
      updated = await this.prisma.booking.update({
        where: { id: entryId },
        data: updateData,
        include: ENTRY_INCLUDE,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.meta as { code?: string } | undefined)?.code === '23P01'
      ) {
        throw new ConflictException('Conflit horaire pour cet employé');
      }
      throw e;
    }
    this.wsGateway.sendCalendarUpdate(userId);
    await this.invalidateBookingsCache(userId, entry.requesterId, entry.providerId);
    return updated;
  }

  async deleteBlock(userId: string, blockId: string) {
    const businessId = await this.getBusinessId(userId);

    const block = await this.prisma.booking.findUnique({
      where: { id: blockId },
      include: { employee: { select: { businessId: true } } },
    });
    if (!block) throw new NotFoundException('Bloc non trouvé');
    if (block.kind !== CalendarEntryKind.BLOCK) {
      throw new BadRequestException(
        'Seuls les blocs peuvent être supprimés de cette façon',
      );
    }
    if (block.employee.businessId !== businessId) {
      throw new ForbiddenException('Accès refusé');
    }

    await this.prisma.booking.delete({ where: { id: blockId } });
    this.wsGateway.sendCalendarUpdate(userId);
    await this.invalidateBookingsCache(userId, block.requesterId, block.providerId);
    return { success: true };
  }

  private async assertNoOverlap(
    employeeId: string,
    startAt: Date,
    endAt: Date,
    excludeId: string | null,
  ) {
    const conflict = await this.prisma.booking.findFirst({
      where: {
        employeeId,
        ...(excludeId && { id: { not: excludeId } }),
        status: { notIn: [BookingStatus.CANCELED, BookingStatus.REJECTED] },
        scheduledAt: { lt: endAt },
        scheduledEndAt: { gt: startAt },
      },
    });
    if (conflict) {
      throw new ConflictException('Conflit horaire pour cet employé');
    }
  }
}
