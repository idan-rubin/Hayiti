---
name: map-my-trip
description: Build or enrich a personal daily route in hayiti from a conversation. Use for first trips, photo GPS imports, reconciling spending, email and calendar events, deduplicating map pins, and comparing daily routes.
---

# Map My Trip

## Start in chat

Start with the traveler's request, such as “Map my trip to Lisbon last week.” Look up their journal and reuse an existing trip and its rules. Resolve destination and dates from the request or authorized itinerary. Ask one short question only if missing details would change the trip. Accept a home base when known and allow the trip to start without one. Let hayiti provide the map, date wheel, edits and sharing. Keep the personal trip private until the traveler asks to share it.

Use the sources the traveler selected. Build with what is available. Connect an optional source only when it adds something they asked for. Report a missing account, an empty search and a failed search separately. For finances, look for credit or checking/debit accounts with purchase history. Match a fare to its ride receipt and an event to its actual date and venue. Keep remote purchases and unconfirmed locations off the route.

## Import photo locations

1. Start with the specified photo service. Treat Google Photos, Google Drive and Apple Photos as separate libraries. Check available integrations once. For Google Photos, use the signed-in Photos website if a connector is unavailable; let the traveler complete sign-in when needed. Reuse the session. Avoid requesting a photo picker, Shortcut, spreadsheet, new album or reorganization when the connected service can supply the metadata.
2. Search the full inclusive trip range by **date taken** in local time across albums. A filename, upload date or album title cannot establish a visit. Check timezone offsets around midnight. For large batches, select the date range once and use original metadata rather than opening every picture. Work with just capture time and coordinates when supplied. Keep originals temporary and outside the public codebase.
3. Use original EXIF capture time and GPS (including HEIC), or media creation time with a timezone and embedded location for videos. Count a Live Photo and its motion companion once. When GPS is missing, check Google Photos Info for a recorded location if available; distinguish an estimated place from a measured point. Retain sources with no usable fix in the summary. Never invent coordinates.
4. Create a stable opaque reference per asset. Filter to trip dates and plausible geography. Group photo-only observations within 100 metres of a fixed pin across the entire local day, even across separate bursts. Measure from the pin, so a sequence of short steps never chains distant places together. Use the earliest chronological capture for the pin coordinates. Include local captureTime to second precision when available. Use the same rule for a preview and the saved journal. Preserve repeat-visit times as evidence. Keep independently identified adjacent venues separate. Allow the same place to appear on different days.
5. Read existing stops for affected dates before writing. Match a unique nearby stop when coordinates, times and place evidence agree. Preserve manual edits, confirmed venue names and taxi endpoints. For ambiguous places use a neutral camera pin. Put photo in sources and stable IDs in refs. Omit images and private photo links unless requested. Respect an existing link's audience.
6. Save approved changes to the owned trip. A request to import is approval for that scope. On retry, read saved references first. Check whether the journal writer appends stops or actually reorders them. Reconcile new times with known visits, home base and ride anchors; preserve the relative order of untimed existing stops. Treat a line between two fixes as an inferred connection. Preserve existing verified street segments.
7. Read back each affected day. Check source references, pin count, near-duplicate coordinates and the saved route order. Show one changed day, link to the private map, and briefly report items checked, missing GPS, places confirmed and pins added. Distinguish a private preview from the saved live journal. Keep a public repo free of trip-specific data.
