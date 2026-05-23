import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingStatus, CalendarEntryKind, Prisma } from '@prisma/client';

// Postgres exclusion-violation code raised by the `booking_no_overlap` constraint.
// See prisma/migrations/20260523000000_prevent_booking_overlap.
const PG_EXCLUSION_VIOLATION = '23P01';
function isBookingOverlapError(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.meta as { code?: string } | undefined)?.code === PG_EXCLUSION_VIOLATION
  );
}
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { ClientsService } from '../clients/clients.service';
import { CacheService } from '../cache/cache.service';
import { computeLoyaltySurcharge } from './pricing.helper';

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
    private websocketGateway: WebsocketGateway,
    @Inject(forwardRef(() => ClientsService))
    private clientsService: ClientsService,
    private cacheService: CacheService,
  ) {}

  async create(userId: string, dto: CreateBookingDto) {
    // Run all independent reads in parallel: service (with tiers + options),
    // employee, the requester's own business (to block pro accounts) and the
    // last COMPLETED booking for loyalty pricing. The "last completed" query
    // is backed by the (requesterId, businessServiceId, status, scheduledAt)
    // composite index — single indexed lookup on a separate connection.
    const [businessService, employee, userBusiness, lastCompletedBooking] =
      await Promise.all([
        this.prisma.businessService.findUnique({
          where: { id: dto.businessServiceId },
          include: {
            business: { include: { owner: true } },
            businessCategory: { include: { options: true } },
            pricingTiers: { orderBy: { thresholdWeeks: 'asc' } },
          },
        }),
        this.prisma.employee.findUnique({ where: { id: dto.employeeId } }),
        this.prisma.business.findUnique({ where: { ownerId: userId } }),
        this.prisma.booking.findFirst({
          where: {
            requesterId: userId,
            businessServiceId: dto.businessServiceId,
            status: 'COMPLETED',
          },
          orderBy: { scheduledAt: 'desc' },
          select: { scheduledAt: true },
        }),
      ]);

    if (!businessService) {
      throw new NotFoundException('Business service not found');
    }

    if (!businessService.business.acceptsOnlineBooking) {
      throw new ForbiddenException(
        'Ce salon n\'accepte pas les réservations en ligne. Contactez-le directement.',
      );
    }

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (employee.businessId !== businessService.businessId) {
      throw new BadRequestException('Employee does not belong to this business');
    }

    // Business owners cannot book appointments
    if (userBusiness) {
      throw new ForbiddenException(
        'Les comptes professionnels ne peuvent pas effectuer de réservations. Veuillez utiliser un compte client.',
      );
    }

    // Check if client is blocked by this business
    const isBlocked = await this.clientsService.isClientBlocked(
      businessService.businessId,
      userId,
    );
    if (isBlocked) {
      throw new ForbiddenException(
        'Vous ne pouvez pas effectuer de réservation auprès de ce professionnel',
      );
    }

    // Validate selected options: each must belong to the service's category, be active,
    // and respect the "one per group" rule for grouped options.
    const selectedIds = dto.selectedOptionIds ?? [];
    const allowedOptions = (businessService.businessCategory?.options ?? []).filter(
      (opt) => opt.isActive,
    );
    const allowedMap = new Map(allowedOptions.map((o) => [o.id, o]));
    const selectedOptions: typeof allowedOptions = [];
    const seenGroups = new Set<string>();
    for (const id of selectedIds) {
      const opt = allowedMap.get(id);
      if (!opt) {
        throw new BadRequestException(
          'Option non disponible pour cette prestation',
        );
      }
      if (opt.groupName) {
        if (seenGroups.has(opt.groupName)) {
          throw new BadRequestException(
            `Une seule option autorisée pour le groupe ${opt.groupName}`,
          );
        }
        seenGroups.add(opt.groupName);
      }
      selectedOptions.push(opt);
    }

    const optionsTotalCents = selectedOptions.reduce(
      (sum, o) => sum + o.priceCents,
      0,
    );
    const optionsTotalMinutes = selectedOptions.reduce(
      (sum, o) => sum + (o.durationMinutes ?? 0),
      0,
    );
    const totalDurationMinutes =
      businessService.durationMinutes + optionsTotalMinutes;

    // Calculate scheduledEndAt based on total duration (service + options)
    let scheduledAt: Date | undefined;
    let scheduledEndAt: Date | undefined;
    if (dto.scheduledAt) {
      scheduledAt = new Date(dto.scheduledAt);
      scheduledEndAt = new Date(scheduledAt.getTime() + totalDurationMinutes * 60000);
    }

    // Loyalty surcharge only applies to FIXED-priced services. Computed
    // server-side from authoritative tiers + COMPLETED-bookings history,
    // never trusting any price value sent by the client.
    const isFixedPrice = businessService.priceMode === 'FIXED';
    const { surchargeCents, appliedTierWeeks } =
      isFixedPrice && scheduledAt
        ? computeLoyaltySurcharge(
            businessService.pricingTiers,
            lastCompletedBooking?.scheduledAt ?? null,
            scheduledAt,
          )
        : { surchargeCents: 0, appliedTierWeeks: null };

    // QUOTE: agreedPriceCents stays null (the pro will set it later).
    // FREE / FIXED: store the computed total (service + options + surcharge).
    const agreedPriceCents =
      businessService.priceMode === 'QUOTE'
        ? null
        : businessService.priceCents + optionsTotalCents + surchargeCents;

    // Check if business has auto-accept enabled
    const autoAccept = businessService.business.autoAcceptBookings;

    // The requester is the user booking, the provider is the business owner.
    // The DB-level `booking_no_overlap` EXCLUDE constraint guarantees that
    // two concurrent inserts on the same employee/time-range cannot both succeed.
    let booking;
    try {
      booking = await this.prisma.booking.create({
        data: {
          requesterId: userId,
          providerId: businessService.business.ownerId,
          businessServiceId: dto.businessServiceId,
          employeeId: dto.employeeId,
          agreedPriceCents,
          appliedTierWeeks,
          scheduledAt,
          scheduledEndAt,
          ...(autoAccept && { status: BookingStatus.ACCEPTED }),
          options: selectedOptions.length
            ? {
                create: selectedOptions.map((opt) => ({
                  serviceOptionId: opt.id,
                  name: opt.name,
                  priceCents: opt.priceCents,
                })),
              }
            : undefined,
        },
        include: {
          businessService: {
            include: {
              business: true,
            },
          },
          employee: true,
          requester: {
            select: {
              id: true,
              name: true,
            },
          },
          provider: {
            select: {
              id: true,
              name: true,
            },
          },
          options: true,
        },
      });
    } catch (e) {
      if (isBookingOverlapError(e)) {
        throw new ConflictException(
          'Ce créneau vient d\'être réservé. Merci d\'en choisir un autre.',
        );
      }
      throw e;
    }

    if (autoAccept) {
      // Auto-accept: notify the client (same flow as manual accept)
      const businessName = businessService.business.name;
      const serviceTitle = businessService.name;
      await this.notificationsService.notifyBookingAccepted(
        userId,
        businessName,
        serviceTitle,
        booking.id,
      );

      // Also notify the business owner about the new auto-accepted booking
      const requesterName = booking.requester.name || 'Quelqu\'un';
      await this.notificationsService.notifyNewBooking(
        businessService.business.ownerId,
        requesterName,
        serviceTitle,
        booking.id,
      );

      // Send real-time status update to requester
      this.websocketGateway.sendBookingStatusUpdate(userId, {
        ...booking,
        status: BookingStatus.ACCEPTED,
      });
    } else {
      // Send notification to business owner (provider)
      const requesterName = booking.requester.name || 'Quelqu\'un';
      await this.notificationsService.notifyNewBooking(
        businessService.business.ownerId,
        requesterName,
        businessService.name,
        booking.id,
      );
    }

    // Auto-create client record (fire-and-forget)
    this.clientsService
      .ensureClient(businessService.businessId, userId)
      .catch(() => {});

    await this.invalidateUserBookingsCache(booking.requesterId, booking.providerId);
    return booking;
  }

  async accept(userId: string, bookingId: string) {
    const booking = await this.findOneOrFail(bookingId);
    this.assertUserInBooking(userId, booking);

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Booking must be PENDING to accept');
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.ACCEPTED },
    });

    // Send notification to requester (use business name instead of owner name)
    const businessName = booking.businessService?.business?.name || booking.provider.name || 'Le prestataire';
    const serviceTitle = booking.businessService?.name || 'un service';
    await this.notificationsService.notifyBookingAccepted(
      booking.requesterId,
      businessName,
      serviceTitle,
      bookingId,
    );

    // Send real-time status update to requester
    this.websocketGateway.sendBookingStatusUpdate(booking.requesterId, {
      ...booking,
      status: BookingStatus.ACCEPTED,
    });

    await this.invalidateUserBookingsCache(booking.requesterId, booking.providerId);
    return updated;
  }

  async complete(userId: string, bookingId: string) {
    const booking = await this.findOneOrFail(bookingId);
    this.assertUserInBooking(userId, booking);

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException('Booking must be ACCEPTED to complete');
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    // Invalidate client stats cache
    const businessId = booking.businessService?.businessId;
    if (businessId) {
      this.cacheService
        .del(CacheService.clientStatsKey(businessId, booking.requesterId))
        .catch(() => {});
    }

    await this.invalidateUserBookingsCache(booking.requesterId, booking.providerId);
    return updated;
  }

  /**
   * Auto-complete bookings that have passed their scheduled time
   */
  async autoCompleteExpiredBookings() {
    const now = new Date();

    const expiredBookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.ACCEPTED,
        kind: CalendarEntryKind.APPOINTMENT,
        scheduledAt: {
          lt: now,
        },
      },
    });

    const results = [];
    for (const booking of expiredBookings) {
      try {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.COMPLETED,
            completedAt: now,
          },
        });
        results.push({ id: booking.id, success: true });
      } catch (error) {
        results.push({ id: booking.id, success: false, error: error.message });
      }
    }

    // The cron may have flipped many bookings across many users — wipe the
    // whole bookings cache rather than hand-tracking each affected user.
    if (results.some((r) => r.success)) {
      await this.cacheService.delByPattern('bookings:user:*');
    }

    return { processed: results.length, results };
  }

  /**
   * Lazy auto-complete: mark expired bookings as COMPLETED for a specific user.
   * Uses updateMany (single SQL query) instead of looping individual updates.
   */
  private async autoCompleteExpiredForUser(userId: string) {
    const now = new Date();

    const result = await this.prisma.booking.updateMany({
      where: {
        status: { in: [BookingStatus.ACCEPTED, BookingStatus.PENDING] },
        kind: CalendarEntryKind.APPOINTMENT,
        scheduledEndAt: { lt: now },
        OR: [{ requesterId: userId }, { providerId: userId }],
      },
      data: {
        status: BookingStatus.COMPLETED,
        completedAt: now,
      },
    });
    return result.count;
  }

  async cancel(userId: string, bookingId: string) {
    const booking = await this.findOneOrFail(bookingId);
    this.assertUserInBooking(userId, booking);

    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.CANCELED
    ) {
      throw new BadRequestException('Cannot cancel a completed or already canceled booking');
    }

    // Clients cannot cancel within 24h of the scheduled start. Pros (provider)
    // remain free to cancel at any time (urgent / health / etc.).
    const isClient = booking.requesterId === userId;
    if (isClient && booking.scheduledAt) {
      const msUntilStart = booking.scheduledAt.getTime() - Date.now();
      if (msUntilStart < 24 * 60 * 60 * 1000 && msUntilStart > 0) {
        throw new BadRequestException({
          code: 'CANCEL_WINDOW_EXPIRED',
          message: 'Cancellation is no longer possible within 24 hours of the appointment.',
        });
      }
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELED, canceledById: userId },
    });

    // Invalidate client stats cache
    const businessId = booking.businessService?.businessId;
    if (businessId) {
      this.cacheService
        .del(CacheService.clientStatsKey(businessId, booking.requesterId))
        .catch(() => {});
    }

    // Determine who is canceling and notify the other party
    const isRequester = booking.requesterId === userId;
    const cancellerName = isRequester
      ? booking.requester.name || 'Le demandeur'
      : booking.businessService?.business?.name || booking.provider.name || 'Le prestataire';
    const serviceTitle = booking.businessService?.name || 'un service';
    const otherUserId = isRequester ? booking.providerId : booking.requesterId;

    await this.notificationsService.notifyBookingCanceled(
      otherUserId,
      cancellerName,
      serviceTitle,
      bookingId,
    );

    // Send real-time status update to the other party
    this.websocketGateway.sendBookingStatusUpdate(otherUserId, {
      ...booking,
      status: BookingStatus.CANCELED,
    });

    await this.invalidateUserBookingsCache(booking.requesterId, booking.providerId);
    return updated;
  }

  async deleteByRequester(userId: string, bookingId: string) {
    const booking = await this.findOneOrFail(bookingId);

    if (booking.requesterId !== userId && booking.providerId !== userId) {
      throw new ForbiddenException('You are not part of this booking');
    }

    if (booking.status !== BookingStatus.CANCELED) {
      throw new BadRequestException('Only canceled bookings can be deleted');
    }

    const deleted = await this.prisma.booking.delete({
      where: { id: bookingId },
    });
    await this.invalidateUserBookingsCache(booking.requesterId, booking.providerId);
    return deleted;
  }

  async reject(userId: string, bookingId: string, message?: string) {
    const booking = await this.findOneOrFail(bookingId);

    if (booking.providerId !== userId) {
      throw new ForbiddenException('Only the provider can reject a booking');
    }

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Booking must be PENDING to reject');
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.REJECTED,
        rejectionMessage: message,
      },
    });

    // Send notification to requester (use business name instead of owner name)
    const businessName = booking.businessService?.business?.name || booking.provider.name || 'Le prestataire';
    const serviceTitle = booking.businessService?.name || 'un service';
    await this.notificationsService.notifyBookingRejected(
      booking.requesterId,
      businessName,
      serviceTitle,
      bookingId,
    );

    // Send real-time status update to requester
    this.websocketGateway.sendBookingStatusUpdate(booking.requesterId, {
      ...booking,
      status: BookingStatus.REJECTED,
      rejectionMessage: message,
    });

    await this.invalidateUserBookingsCache(booking.requesterId, booking.providerId);
    return updated;
  }

  async findByUser(userId: string, role?: 'requester' | 'provider', from?: string, to?: string) {
    // First, auto-complete any expired ACCEPTED bookings for this user. If
    // anything was actually flipped, the bookings cache for this user is now
    // stale and must be busted before serving from it.
    const autoCompleted = await this.autoCompleteExpiredForUser(userId);
    if (autoCompleted > 0) {
      await this.invalidateUserBookingsCache(userId);
    }

    const cacheKey = CacheService.bookingsUserKey(userId, role, from, to);
    type Result = Awaited<ReturnType<typeof this.findByUserUncached>>;
    const cached = await this.cacheService.get<Result>(cacheKey);
    if (cached) return cached;

    const result = await this.findByUserUncached(userId, role, from, to);
    await this.cacheService.set(cacheKey, result, CacheService.TTL.BOOKINGS_USER);
    return result;
  }

  private async findByUserUncached(
    userId: string,
    role?: 'requester' | 'provider',
    from?: string,
    to?: string,
  ) {
    const where: any = {};

    if (role === 'requester') {
      where.requesterId = userId;
    } else if (role === 'provider') {
      where.providerId = userId;
    } else {
      where.OR = [{ requesterId: userId }, { providerId: userId }];
    }

    // Date filtering on scheduledAt
    if (from || to) {
      where.scheduledAt = {};
      if (from) {
        where.scheduledAt.gte = new Date(from);
      }
      if (to) {
        where.scheduledAt.lte = new Date(to);
      }
    }

    return this.prisma.booking.findMany({
      where,
      include: {
        businessService: {
          include: {
            business: {
              select: { id: true, name: true, slug: true, address: true, city: true },
            },
          },
        },
        employee: {
          select: { id: true, firstName: true, lastName: true, avatarUrl: true },
        },
        requester: {
          select: {
            id: true,
            name: true,
          },
        },
        provider: {
          select: {
            id: true,
            name: true,
          },
        },
        reviews: true,
        options: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns the most recent completed-but-unreviewed booking for `userId`
   * with `businessId`, or null. Used as a cheap probe instead of fetching
   * /bookings/me and filtering client-side.
   */
  async findReviewableBookingForBusiness(userId: string, businessId: string) {
    if (!businessId) return null;
    const booking = await this.prisma.booking.findFirst({
      where: {
        requesterId: userId,
        status: BookingStatus.COMPLETED,
        businessService: { businessId },
        reviews: { none: { type: 'REVIEW_PROVIDER' } },
      },
      orderBy: { completedAt: 'desc' },
      select: {
        id: true,
        completedAt: true,
        businessService: { select: { id: true, name: true } },
      },
    });
    return booking;
  }

  /**
   * Invalidate every cached `/bookings/me` variant for one or two users.
   * Mutations that touch a booking can affect both the requester and the
   * provider, so callers usually pass both IDs.
   */
  private async invalidateUserBookingsCache(...userIds: (string | null | undefined)[]) {
    const unique = Array.from(new Set(userIds.filter((u): u is string => !!u)));
    await Promise.all(
      unique.map((id) =>
        this.cacheService.delByPattern(`bookings:user:${id}:*`),
      ),
    );
  }

  async findOne(bookingId: string) {
    return this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        businessService: {
          include: {
            business: true,
          },
        },
        employee: true,
        requester: {
          select: {
            id: true,
            name: true,
          },
        },
        provider: {
          select: {
            id: true,
            name: true,
          },
        },
        reviews: true,
        options: true,
      },
    });
  }

  async findOneOrFail(bookingId: string) {
    const booking = await this.findOne(bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }

  /**
   * Revenue stats: daily aggregation of completed bookings over a date range.
   * Returns { date, revenue, count } for each day with at least one completed booking.
   */
  async getRevenueStats(userId: string, from: Date, to: Date) {
    const bookings = await this.prisma.booking.findMany({
      where: {
        providerId: userId,
        status: BookingStatus.COMPLETED,
        scheduledAt: { gte: from, lte: to },
      },
      select: {
        scheduledAt: true,
        agreedPriceCents: true,
      },
      orderBy: { scheduledAt: 'asc' },
    });

    // Group by day
    const dayMap = new Map<string, { revenue: number; count: number }>();
    for (const b of bookings) {
      const day = b.scheduledAt!.toISOString().slice(0, 10);
      const existing = dayMap.get(day) || { revenue: 0, count: 0 };
      existing.revenue += b.agreedPriceCents || 0;
      existing.count += 1;
      dayMap.set(day, existing);
    }

    return Array.from(dayMap.entries()).map(([date, stats]) => ({
      date,
      revenue: stats.revenue,
      count: stats.count,
    }));
  }

  private assertUserInBooking(userId: string, booking: any) {
    if (booking.requesterId !== userId && booking.providerId !== userId) {
      throw new ForbiddenException('You are not part of this booking');
    }
  }
}
