#!/usr/bin/env npx ts-node
/**
 * Export a business from local DB to a prod-ready SQL seed file.
 *
 * Usage (business already exists in prod — UPDATE):
 *   npx ts-node scripts/export-business-to-prod.ts \
 *     --businessId <local_business_id> \
 *     --prodUserId <existing_prod_user_id> \
 *     --prodBusinessId <existing_prod_business_id> \
 *     [--out ./scripts/seed-<name>.sql]
 *
 * Usage (business does not exist in prod — INSERT):
 *   npx ts-node scripts/export-business-to-prod.ts \
 *     --businessId <local_business_id> \
 *     --prodUserId <existing_prod_user_id> \
 *     [--out ./scripts/seed-<name>.sql]
 *
 * Then run the generated file against prod:
 *   psql "PROD_DATABASE_URL" -f ./scripts/seed-<name>.sql
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const businessId = get('--businessId');
const prodUserId = get('--prodUserId');
const prodBusinessId = get('--prodBusinessId'); // optional: if set, UPDATE instead of INSERT

if (!businessId || !prodUserId) {
  console.error('Usage: npx ts-node scripts/export-business-to-prod.ts --businessId <id> --prodUserId <id> [--prodBusinessId <id>] [--out <file>]');
  process.exit(1);
}

const prisma = new PrismaClient();

function esc(val: string | null | undefined): string {
  if (val === null || val === undefined) return 'NULL';
  return `'${val.replace(/'/g, "''")}'`;
}

function escBool(val: boolean): string {
  return val ? 'true' : 'false';
}

function escNum(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'NULL';
  return String(val);
}

function escDate(val: Date | null | undefined): string {
  if (!val) return 'NULL';
  return `'${val.toISOString()}'`;
}

async function main() {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId! },
    include: {
      categories: true,
      services: true,
      employees: true,
      hours: true,
      billingSettings: true,
    },
  });

  const lines: string[] = [];
  lines.push(`-- Seed script: ${business.name} → prod`);
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push(`-- Prod user: ${prodUserId}${prodBusinessId ? ` / Prod business: ${prodBusinessId}` : ''}`);
  lines.push('');
  lines.push('BEGIN;');
  lines.push('');

  const targetBusinessId = prodBusinessId ?? business.id;

  lines.push('-- Business');
  if (prodBusinessId) {
    lines.push(`UPDATE "Business" SET`);
    lines.push(`  "name"                 = ${esc(business.name)},`);
    lines.push(`  "slug"                 = ${esc(business.slug)},`);
    lines.push(`  "description"          = ${esc(business.description)},`);
    lines.push(`  "logoUrl"              = ${esc(business.logoUrl)},`);
    lines.push(`  "coverUrl"             = ${esc(business.coverUrl)},`);
    lines.push(`  "phone"                = ${esc(business.phone)},`);
    lines.push(`  "email"                = ${esc(business.email)},`);
    lines.push(`  "website"              = ${esc(business.website)},`);
    lines.push(`  "address"              = ${esc(business.address)},`);
    lines.push(`  "city"                 = ${esc(business.city)},`);
    lines.push(`  "postalCode"           = ${esc(business.postalCode)},`);
    lines.push(`  "country"              = ${esc(business.country)},`);
    lines.push(`  "latitude"             = ${escNum(business.latitude)},`);
    lines.push(`  "longitude"            = ${escNum(business.longitude)},`);
    lines.push(`  "categoryId"           = ${esc(business.categoryId)},`);
    lines.push(`  "isEarlyAdopter"       = ${escBool(business.isEarlyAdopter)},`);
    lines.push(`  "isVerified"           = ${escBool(business.isVerified)},`);
    lines.push(`  "isActive"             = ${escBool(business.isActive)},`);
    lines.push(`  "acceptsOnlineBooking" = ${escBool(business.acceptsOnlineBooking)},`);
    lines.push(`  "autoAcceptBookings"   = ${escBool(business.autoAcceptBookings)},`);
    lines.push(`  "freeMonthsEarned"     = ${escNum(business.freeMonthsEarned)},`);
    lines.push(`  "presentation"         = ${esc(business.presentation)},`);
    lines.push(`  "updatedAt"            = now()`);
    lines.push(`WHERE "id" = ${esc(prodBusinessId)};`);
  } else {
    lines.push(`INSERT INTO "Business" (`);
    lines.push(`  "id", "ownerId", "name", "slug", "description", "logoUrl", "coverUrl",`);
    lines.push(`  "phone", "email", "website", "address", "city", "postalCode", "country",`);
    lines.push(`  "latitude", "longitude", "subscriptionTier", "subscriptionStatus",`);
    lines.push(`  "isVerified", "isActive", "acceptsOnlineBooking", "isOnVacation",`);
    lines.push(`  "categoryId", "isEarlyAdopter", "presentation", "autoAcceptBookings",`);
    lines.push(`  "freeMonthsEarned", "createdAt", "updatedAt"`);
    lines.push(`) VALUES (`);
    lines.push(`  ${esc(business.id)}, ${esc(prodUserId)}, ${esc(business.name)}, ${esc(business.slug)},`);
    lines.push(`  ${esc(business.description)}, ${esc(business.logoUrl)}, ${esc(business.coverUrl)},`);
    lines.push(`  ${esc(business.phone)}, ${esc(business.email)}, ${esc(business.website)},`);
    lines.push(`  ${esc(business.address)}, ${esc(business.city)}, ${esc(business.postalCode)}, ${esc(business.country)},`);
    lines.push(`  ${escNum(business.latitude)}, ${escNum(business.longitude)},`);
    lines.push(`  ${esc(business.subscriptionTier)}, ${esc(business.subscriptionStatus)},`);
    lines.push(`  ${escBool(business.isVerified)}, ${escBool(business.isActive)}, ${escBool(business.acceptsOnlineBooking)}, ${escBool(business.isOnVacation)},`);
    lines.push(`  ${esc(business.categoryId)}, ${escBool(business.isEarlyAdopter)}, ${esc(business.presentation)}, ${escBool(business.autoAcceptBookings)},`);
    lines.push(`  ${escNum(business.freeMonthsEarned)}, ${escDate(business.createdAt)}, ${escDate(business.updatedAt)}`);
    lines.push(`) ON CONFLICT ("id") DO NOTHING;`);
  }
  lines.push('');

  // BusinessCategories
  if (business.categories.length > 0) {
    lines.push('-- BusinessCategories');
    lines.push(`INSERT INTO "BusinessCategory" ("id", "businessId", "name", "sortOrder", "createdAt", "updatedAt") VALUES`);
    const catRows = business.categories.map((c) =>
      `  (${esc(c.id)}, ${esc(targetBusinessId)}, ${esc(c.name)}, ${escNum(c.sortOrder)}, ${escDate(c.createdAt)}, ${escDate(c.updatedAt)})`
    );
    lines.push(catRows.join(',\n') + '\nON CONFLICT ("id") DO NOTHING;');
    lines.push('');
  }

  // BusinessServices
  if (business.services.length > 0) {
    lines.push('-- BusinessServices');
    lines.push(`INSERT INTO "BusinessService" ("id", "businessId", "name", "description", "priceCents", "currency", "durationMinutes", "isActive", "businessCategoryId", "detailedDescription", "priceMode", "createdAt", "updatedAt") VALUES`);
    const svcRows = business.services.map((s) =>
      `  (${esc(s.id)}, ${esc(targetBusinessId)}, ${esc(s.name)}, ${esc(s.description)}, ${escNum(s.priceCents)}, ${esc(s.currency)}, ${escNum(s.durationMinutes)}, ${escBool(s.isActive)}, ${esc(s.businessCategoryId)}, ${esc(s.detailedDescription)}, ${esc(s.priceMode)}, ${escDate(s.createdAt)}, ${escDate(s.updatedAt)})`
    );
    lines.push(svcRows.join(',\n') + '\nON CONFLICT ("id") DO NOTHING;');
    lines.push('');
  }

  // Employees
  if (business.employees.length > 0) {
    lines.push('-- Employees');
    lines.push(`INSERT INTO "Employee" ("id", "businessId", "userId", "firstName", "lastName", "email", "phone", "avatarUrl", "role", "bio", "isActive", "createdAt", "updatedAt") VALUES`);
    const empRows = business.employees.map((e) =>
      `  (${esc(e.id)}, ${esc(targetBusinessId)}, NULL, ${esc(e.firstName)}, ${esc(e.lastName)}, ${esc(e.email)}, ${esc(e.phone)}, ${esc(e.avatarUrl)}, ${esc(e.role)}, ${esc(e.bio)}, ${escBool(e.isActive)}, ${escDate(e.createdAt)}, ${escDate(e.updatedAt)})`
    );
    lines.push(empRows.join(',\n') + '\nON CONFLICT ("id") DO NOTHING;');
    lines.push('');
  }

  // BusinessHours
  if (business.hours.length > 0) {
    lines.push('-- BusinessHours');
    lines.push(`INSERT INTO "BusinessHours" ("id", "businessId", "dayOfWeek", "startTime", "endTime", "isClosed") VALUES`);
    const hourRows = business.hours.map((h) =>
      `  (${esc(h.id)}, ${esc(targetBusinessId)}, ${escNum(h.dayOfWeek)}, ${esc(h.startTime)}, ${esc(h.endTime)}, ${escBool(h.isClosed)})`
    );
    lines.push(hourRows.join(',\n') + '\nON CONFLICT ("id") DO NOTHING;');
    lines.push('');
  }

  // BillingSettings
  if (business.billingSettings) {
    const b = business.billingSettings;
    lines.push('-- BusinessBillingSettings');
    lines.push(`INSERT INTO "BusinessBillingSettings" (`);
    lines.push(`  "id", "businessId", "legalName", "addressLine1", "addressLine2", "postalCode", "city", "country",`);
    lines.push(`  "siret", "vatNumber", "vatMode", "invoicePrefix", "nextInvoiceSequence", "logoKey", "paymentTerms",`);
    lines.push(`  "acreActive", "acreEndDate", "incomeTaxRate", "legalForm", "urssafRate", "createdAt", "updatedAt"`);
    lines.push(`) VALUES (`);
    lines.push(`  ${esc(b.id)}, ${esc(targetBusinessId)}, ${esc(b.legalName)}, ${esc(b.addressLine1)}, ${esc(b.addressLine2)},`);
    lines.push(`  ${esc(b.postalCode)}, ${esc(b.city)}, ${esc(b.country)},`);
    lines.push(`  ${esc(b.siret)}, ${esc(b.vatNumber)}, ${esc(b.vatMode)}, ${esc(b.invoicePrefix)},`);
    lines.push(`  ${escNum(b.nextInvoiceSequence)}, ${esc(b.logoKey)}, ${esc(b.paymentTerms)},`);
    lines.push(`  ${escBool(b.acreActive)}, ${escDate(b.acreEndDate)}, ${escNum(b.incomeTaxRate)},`);
    lines.push(`  ${esc(b.legalForm as string)}, ${escNum(b.urssafRate)}, ${escDate(b.createdAt)}, ${escDate(b.updatedAt)}`);
    lines.push(`) ON CONFLICT ("id") DO NOTHING;`);
    lines.push('');
  }

  lines.push('COMMIT;');

  const slug = business.slug.replace(/[^a-z0-9-]/g, '-');
  const outFile = get('--out') || path.join(__dirname, `seed-prod-${slug}.sql`);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf-8');
  console.log(`✓ Generated: ${outFile}`);
  console.log(`\nRun against prod:`);
  console.log(`  psql "PROD_DATABASE_URL" -f ${outFile}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
