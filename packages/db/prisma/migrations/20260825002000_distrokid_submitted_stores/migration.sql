-- Stores DistroKid reports it submitted a release to, read from the album page's "Submitted to X"
-- store icons: a JSON array of { store, url } (url = DistroKid's deep-link to the release on that
-- store, when it provides one). The authoritative delivery signal, surfaced as "Delivered by
-- DistroKid" for stores that independent (API/search) verification can't confirm. NULL = not captured.
ALTER TABLE "DistributorReleaseOutcome"
  ADD COLUMN "submittedStores" JSONB;
