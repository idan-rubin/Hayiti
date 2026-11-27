<h1><img src="docs/hayiti-logo.png" width="300" alt="hayiti"></h1>

**Reverse-engineer your trip.**

hayiti rebuilds where you went, one day at a time, from the traces you already leave behind: photos, ride receipts, card purchases, calendar events and saved places. An AI does the work. [ChatGPT](https://chatgpt.com/) reads the sources you choose, works out where you were and proposes each day's stops. You decide what to keep, and hayiti draws the days on a map.

It is made for trips you planned yourself. Nobody handed you an itinerary, and you were too busy living the days to write them down. A few weeks later a friend asks where you ate, and you can picture the place but the name is gone. The evidence is still there. hayiti puts it back in order.

An itinerary app keeps the plan. hayiti recovers what happened.

[Open the web app](https://hayiti-beta.cocoacoati256.chatgpt.site) · [Download the portable journal](https://hayiti-beta.cocoacoati256.chatgpt.site/Hayiti.zip) · [Read the story: “Hey Dot, Can You Map Where I Went?”](https://mrrubin.substack.com/p/hey-dot-can-you-map-where-i-went)

*hayiti (הייתי) is Hebrew for “I was.”*

## The AI does the heavy lifting

Be clear about where the work happens. Gathering the evidence, deciding which café a charge belongs to, stitching a day into order: all of that is the AI. hayiti never connects to your bank, your mailbox or your photo library.

This repository is the template around that work.

| The AI | This repository |
| --- | --- |
| Reads the sources you authorize | A journal that holds and shows the result |
| Works out the place, the branch and the day | The tools the AI saves through, which check every write |
| Puts the stops in order and finds the routes between them | A [playbook](skills/map-my-trip/SKILL.md) that tells the AI how to do the job |
| Asks you when the evidence runs out | The lessons learned, written down as rules and tests |

Today that AI is ChatGPT. The tools speak MCP and the playbook is plain Markdown, so the same template can serve another agent. Better models will do the job better. The template tells any of them what a good answer looks like.

### What the playbook has learned

The obvious approach goes wrong in specific ways. The playbook and the tests encode them.

- A chain charge names the brand, not the branch. Don't guess one.
- A charge can post days after the purchase. Use the transaction date.
- An online order is a purchase, not a visit.
- A booking or a calendar event is a plan, not proof you went.
- A taxi fare alone does not say which part of the day it was. The receipt's pickup and drop-off do.
- A saved place is a bookmark, not a visit.
- Photos taken a few steps apart are one stop, and the earliest one sets the pin.
- Today's opening hours are a hint about a past date, not a fact.

## What each clue can tell you

No single source is enough. Each one answers a different question.

| Clue | What it tells you | What it leaves open |
| --- | --- | --- |
| **Photos** | Where you were and when, if the photo saved its location | What the place was and what you did there |
| **Ride receipts** | Where a ride started and ended, and at what time | What you did at either end |
| **Card purchases** | What you paid for, and on which day | Which branch, and whether you were there in person |
| **Calendar and bookings** | What was planned, with a time and often an address | Whether it happened |
| **Saved places** | What you meant to see | Whether you went |
| **Your memory** | Everything the rest missed | |

A photo knows the place but not what you did there. A charge knows what you bought but often not where. Put together, they make a day.

## What goes on the map

- **You approve every stop.** ChatGPT shows what it found before anything is saved. A file import shows a preview first.
- **Only a place with a pin joins the route.** A charge from a chain with many branches stays under **More about this day**, with the reason and an **Add address** action. hayiti does not guess a branch. Once you or another clue place it, the same purchase joins the numbered stops.
- **Clues that agree become one stop.** Records from different sources that match on place and time are combined. Anything ambiguous stays separate for you to review.
- **Bookmarks stay apart.** A place saved in Google Maps appears as a **Google Pin**, outside the route and the walking distance.

## Start with one day

**With ChatGPT.** Connect hayiti in ChatGPT, then ask:

> Map my trip to Tel Aviv last week. I stayed near the market. Use my photos, receipts and calendar to work out where I went each day.

ChatGPT asks for anything missing, such as the dates or where you stayed. It cross-checks the sources you authorize, shows you the stops, and saves the ones you approve. Open the web app with the same account to see your days. From a photo, hayiti saves only the capture time and location, not the picture. For purchases, ChatGPT can use its [Finances tab](https://chatgpt.com/finances/).

**Without an account.** In the web app or the portable journal, open **Sources and import**, copy the sync request into your conversation, and import the file ChatGPT returns under **Files**.

**By hand.** Choose **New trip**, pick a day, choose **+ Stop** and enter a place. You can also import a transaction file (`.csv`), a calendar file (`.ics`) or an email (`.eml`).

## A Thursday in Tel Aviv

The sample trip shows a day put back together. Card receipts put you at Café Sonder by the Carmel Market and Anita Gelato in Neve Tzedek. The taxi receipt fills in what card charges can’t. Pickup in Neve Tzedek at 2:40 p.m., drop-off on Shaul HaMelech Boulevard fourteen minutes later. Two more charges follow, at the Tel Aviv Museum of Art and Schnitt Brewing Company, and the calendar has a concert at Tzavta at 8:30.

![The sample route on the streets of Tel Aviv. An orange dashed line marks the taxi ride from Neve Tzedek to Shaul HaMelech Boulevard.](docs/screenshots/sample-street-map.png)

The orange dashed line shows the taxi ride. Taxi pins show approximate locations. In an empty journal, choose **Try the sample trip**. The [downloadable example](https://hayiti-beta.cocoacoati256.chatgpt.site/sample-trip.json) contains all seven stops. To add it next to your own trips, import it under **Sources and import** → **Files** and choose **Load trip**.

## Reading a day

- **Numbered stops** appear in order, each with a pin. Between stops hayiti estimates a walk. A ride matched to a receipt is drawn as a dashed line.
- **More about this day** holds what could not be placed: places without a pin, visits to confirm and remote purchases.
- **Whole trip** shows every day on one map, each day's route drawn separately. Choose streets, satellite imagery or terrain.
- **Edit anything.** Move a stop up or down, fix a time or an address, or mark a location as approximate.

On a phone, choose **Stops** to see the day's visits in order.

<img src="docs/screenshots/sample-stops.png" width="320" alt="Mobile stop list for the sample day, showing card purchases, two ends of a taxi ride and an evening concert.">

## It is your record

hayiti is a private journal first.

- **Where it lives.** Signed in, your journal is stored with your account. Without signing in, it stays in that browser. The portable journal is a single file that works offline and needs the internet only for the street map and address lookup.
- **Keeping it.** **Back up trip** downloads an editable copy you can import anywhere.
- **Sharing is optional.** **Share** makes a read-only route for a day or a whole trip. It leaves out notes, photos, Google Pins and source references. Your home base is left out unless you include it. A hosted link can be revoked.

See the [privacy policy](https://hayiti-beta.cocoacoati256.chatgpt.site/privacy.html) for what each service receives.

## What it cannot know

- A day with no photos, no rides and only chain-store charges gives the AI little to place. The charges still appear under the day, ready for what you remember.
- Photos help only when their location was saved with them.
- An entry the evidence cannot settle waits under **Visits to confirm** until you decide.
- Walking distances are estimates.

---

# Reference

## How hayiti reads your evidence

- **Imports.** Create or select a trip before importing transactions (`.csv`), calendar events (`.ics`) or email (`.eml`). Include a transaction date. A payment channel such as `in store` or `online` identifies the type of purchase even when the merchant name is missing. A trip backup (`.json`) can open a trip in an empty journal. You can also place a pin by hand.
- **Photos.** On each day, photo locations within 100 metres of a saved photo pin share that pin. The earliest known capture supplies the displayed pin. The grouping radius stays fixed, so a walk across several blocks can still add new stops.
- **Matching.** hayiti checks the day and source reference before adding a stop. Independent records with matching places, compatible times and compatible addresses can corroborate one visit. Ambiguous matches stay separate for review.
- **Order and distance.** Date, time, ordering rules and location inform the suggested order. Each adjacent pair can carry its own route. Walking is the estimate for each pair unless evidence identifies a different mode. This includes longer walks and crossings between cities. A taxi ride matched to the pair follows the driving network. When directions are unavailable, the journal keeps its existing route or estimated connector. Walking totals use recorded walking segments.
- **More about this day.** The panel starts collapsed when the day has numbered stops, and opens automatically when it only has additional entries.
- **Google Pins.** Ask ChatGPT to add saved places from a Google Maps list it can read. A pin appears on its assigned day and in the trip overview, independently of visit counts and route distances. Pins without a known trip day appear in the overview, where you can assign a day yourself. A save timestamp, when available, records when you bookmarked the place. Removing a pin keeps it out of later imports for that trip. To bring it back, import a saved-places file containing it, then choose **Restore a removed pin** in the preview.
- **Source status.** Each requested source has a dated status. Finances distinguishes a disconnected source, missing credit or debit accounts, zero transactions and purchases without a mappable place. Gmail and Calendar can contribute independently.
- **Sharing.** You can choose a general place, such as a market, and use an approximate pin on the shared map. The share keeps your chosen place name and omits its street address. A downloaded copy stays with its recipient.
- **Offline.** Saving a stop with an address and no map pin looks the address up and adds the pin. Offline, pins and routes are drawn without the streets. Place names on the street map follow the journal's language, English or Hebrew, and fall back to the local name.

## For agents

Agents connecting over MCP receive the trip-building instructions during initialization. The [Map My Trip skill](skills/map-my-trip/SKILL.md) covers source checks, identifying the correct venue, resolving visit order, and saving the route. For an untimed purchase the agent checks branch-specific hours and the traveler's account before using distance to break a tie. A booking time or a bank posting can differ from the time of a visit.

ChatGPT connects to the hosted journal using OAuth and the [MCP connection manifest](directory/mcp.json). With hayiti connected, try asking “Which trips are in my journal?” or “Where did I go on the first day of my trip?” ChatGPT reads trips saved to your hosted account. The portable journal keeps its own copy.

ChatGPT uses `list_trips`, `get_day` and `add_trip_stops` to reconcile approved visits. `list_google_pins` pages through saved places, and `restore_google_pin` brings back one the traveler removed, only at their request. When the traveler supplies a missing branch or chooses a general place label, `correct_stop_location` updates the existing stop using the revision from `get_day`. The agent uses `set_day_routes` to save estimated paths for adjacent stops on a day. A proposed order can be saved with the paths in the same operation. Supply the previously read and proposed sequences of mapped visit, pickup and drop-off IDs in `order: {previous, next}`. A mismatch prompts a fresh read before applying changes.

If a traveler identifies a misclassified taxi ride, read `get_day` and pass its `revision` as `expectedRevision` to `set_day_routes`. Set `correctTaxi: true` on that exact leg and supply walking directions or an explicit gap. The former pickup and drop-off become ordinary visits. They can then be reordered independently. Portable route files accept the same correction flag on the leg.

### Generate directions with OSRM

An agent with access to an OSRM-compatible router can use the bundled TypeScript adapter. Configure the route URLs for the pedestrian and driving datasets available to you. OSRM's travel mode depends on the profile used to prepare each dataset. The adapter also checks the travel mode returned by the router. [OSRM API documentation](https://project-osrm.org/docs/v5.24.0/api/)

For example, two local OSRM instances might serve the pedestrian and driving datasets on ports 5001 and 5002. A plan contains only the pairs that need directions. Each pair identifies the adjacent stop IDs and endpoints in latitude, longitude order. Omit `type` for an estimated walk or specify `taxi` for a known ride.

```json
{"tripId":"example","days":[{"date":"2026-03-12","legs":[{"a":"cafe","b":"museum","from":[51.92,4.48],"to":[51.918,4.476]}]}]}
```

```sh
HAYITI_WALK_ROUTE_URL=http://localhost:5001/route/v1/foot \
HAYITI_DRIVE_ROUTE_URL=http://localhost:5002/route/v1/driving \
node scripts/route-trip.ts < plan.json > routes.json
```

Save each day's `routes` with `set_day_routes`, or open **Sources and import → Files** and import the package into the matching trip. A routing service receives endpoint coordinates. The adapter makes sequential requests and reuses repeated coordinate pairs within the same run. Pairs with no usable route are omitted and reported on stderr, preserving their previous display. A service failure stops the run before it emits a package.

## Build from source

You need Node.js 26 LTS and npm. Node.js 24.12 or later on the 24.x line also works, and CI checks both. From the repository root, run these commands.

```sh
npm ci
npm run build
```

Open `dist/web/Hayiti.html` directly in your browser. The build also creates `dist/web/Hayiti.zip` for distribution and `dist/server/app.mjs` for the hosted journal.

TypeScript 7 checks the application, tests and build scripts. Type-aware ESLint uses the TypeScript 6 compiler API.

## Reading the code

| Start here | Responsibility |
| --- | --- |
| [Trip and Stop](src/domain/core.ts) | Typed domain model, validation and evidence matching |
| [Importers](src/domain/importers.ts) | CSV, calendar and pasted evidence, plus suggested stop order |
| [Daily route](src/domain/daily-route.ts) | Map sequence and walking-distance calculations |
| [Sharing](src/domain/share-format.ts) | Builds a shareable snapshot from an explicit list of allowed fields |
| [Journal UI](src/web/journal-app.ts) | The browser application |
| [HTTP entry point](src/server/app.ts) | Routes authenticated journal requests, MCP requests and shared views |
| [Agent tools](src/server/tools.ts) | The MCP tools and their input schemas |
| [Object storage](src/server/storage.ts) | Per-user records and conditional writes that prevent lost edits |
| [Tests](test) | Domain, server and browser suites |

## Hosted integration

The build produces browser assets in `dist/web/` and an ES module in `dist/server/app.mjs`. A host calls `handleRequest(request, bindings, verifiedUserId, serveAsset)`. The host authenticates the session or OAuth token and supplies the verified user ID, or `null` for anonymous requests. Configure the sign-in endpoint on that host. Running the portable file needs no account.

Provide a private R2-compatible `BUCKET` and your HTTPS `PUBLISHER_ORIGIN`. To enable hosted sharing, set `HAYITI_SHARE_RELAY` as a host secret. An optional companion journal can set the same secret and use its own origin as `RELAY_ORIGIN` on the publisher. Use the same publisher origin on both hosts. See [the binding types](src/server/storage.ts).

## Definition of done

From a checkout with dependencies installed, run the same checks as CI.

```sh
npm run check
npx --no-install playwright-core install chromium
npm run test:browser
```

- `npm run check` verifies the TypeScript source policy, type checking and ESLint, runs the domain and server tests, and builds the portable and hosted artifacts.
- `npm run test:browser` runs the portable and hosted journals in Chromium against local fixtures, with outside network requests blocked.
- Before merging, the branch must be up to date with `main`, and **Verify hayiti**, **Scan TypeScript** and **CodeQL** must pass on GitHub. [CI workflow](.github/workflows/ci.yml) · [CodeQL workflow](.github/workflows/codeql.yml)

## Contributing

Use a branch and open a pull request. Describe the user-visible behavior and add a regression test for a bug fix. Use fictional trips in issues, pull requests and fixtures.

hayiti's source is licensed under [MIT](LICENSE). Leaflet, MapLibre GL JS and the MapLibre GL Leaflet layer retain their upstream licenses: [Leaflet](public/vendor/leaflet-LICENSE), [MapLibre GL JS](public/vendor/maplibre-gl-LICENSE.txt), [MapLibre GL Leaflet](public/vendor/maplibre-gl-leaflet-LICENSE.txt). The street map comes from [OpenFreeMap](https://openfreemap.org/) and uses OpenMapTiles and OpenStreetMap contributors’ data. Satellite imagery uses the [2016 Sentinel-2 cloudless mosaic from EOX](https://cloudless.eox.at/). The terrain layer uses [OpenTopoMap](https://opentopomap.org/about). The map displays credits for the active provider. See [security reporting](SECURITY.md).
