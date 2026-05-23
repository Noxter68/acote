-- Prevent double-booking at the database level using a PostgreSQL EXCLUDE constraint.
-- Two active bookings on the same employee cannot have overlapping time ranges.
-- The constraint is atomic and race-condition free — no transaction or lock required.

-- btree_gist is needed to mix the equality operator (=) on employeeId
-- with the range overlap operator (&&) inside the same EXCLUDE constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Backfill: cancel any pre-existing overlapping bookings so the constraint can be added.
-- For each pair of overlapping active bookings on the same employee, the later-created
-- one (or the one with the higher id as tiebreaker) is marked CANCELED.
UPDATE "Booking"
SET "status" = 'CANCELED',
    "notes" = COALESCE("notes" || E'\n', '') || '[Auto-annulé: conflit horaire détecté lors de la migration]'
WHERE id IN (
  SELECT DISTINCT b1.id
  FROM "Booking" b1
  JOIN "Booking" b2
    ON b1."employeeId" = b2."employeeId"
   AND b1.id <> b2.id
   AND b1."scheduledAt" < b2."scheduledEndAt"
   AND b1."scheduledEndAt" > b2."scheduledAt"
   AND b2."status" NOT IN ('CANCELED', 'REJECTED')
   AND b2."scheduledAt" IS NOT NULL
   AND b2."scheduledEndAt" IS NOT NULL
   AND (
     b1."createdAt" > b2."createdAt"
     OR (b1."createdAt" = b2."createdAt" AND b1.id > b2.id)
   )
  WHERE b1."status" NOT IN ('CANCELED', 'REJECTED')
    AND b1."scheduledAt" IS NOT NULL
    AND b1."scheduledEndAt" IS NOT NULL
);

-- Booking.scheduledAt / scheduledEndAt are `timestamp(3) without time zone` in this
-- schema, so we use tsrange (not tstzrange) which is IMMUTABLE on plain timestamps.
ALTER TABLE "Booking"
  ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    tsrange("scheduledAt", "scheduledEndAt", '[)') WITH &&
  )
  WHERE (
    "status" NOT IN ('CANCELED', 'REJECTED')
    AND "scheduledAt" IS NOT NULL
    AND "scheduledEndAt" IS NOT NULL
  );
