<h1><img src="docs/hayiti-logo.png" width="300" alt="hayiti"></h1>

hayiti is a trip journal that works with [ChatGPT](https://chatgpt.com/) and its [Finances tab](https://chatgpt.com/finances/). ChatGPT helps you piece together each day from the sources you choose. A card purchase might tell you where you ate, a taxi receipt in Gmail might show where you went next, and Google Calendar might remind you of a concert that evening. You choose which stops to save and can add anything else you remember by hand.

After a long trip, whole days blur together. A friend asks where you ate, and you can picture the place but the name is gone. Your receipts still have a place and a date on them. Start with one stop and piece together the rest a day at a time, even if you never wrote a journal entry while you were away.

[Open the web app](https://hayiti-beta.cocoacoati256.chatgpt.site) · [Download the portable journal](https://hayiti-beta.cocoacoati256.chatgpt.site/Hayiti.zip)

## Rebuild a trip with ChatGPT Finances

1. Connect hayiti in ChatGPT. In the Finances tab, link the credit card or checking account you used for purchases on the trip.
2. Open the hayiti web app and choose **Sign in with ChatGPT**. Select a trip or choose **New trip** and enter its dates.
3. In **Sources and import**, open **Connected accounts**. **Finances transactions** is already selected. Select **Gmail** or **Google Calendar** too if you want ChatGPT to include receipts, reservations or events.
4. Choose **Copy sync request**, then **Open ChatGPT**. Paste the request into a chat with hayiti connected. ChatGPT suggests stops for your trip dates. If a restaurant charge and an emailed receipt point to the same meal, they can describe a single stop. Uncertain matches stay separate for review.
5. Tell ChatGPT which stops to save. The journal picks up the new stops when you return to its tab. Select a day to see its route.

Using the portable journal, or the web app without signing in? The sync request asks ChatGPT for a JSON file. Import that file into your trip under **Sources and import** → **Files**.

## A Thursday in Tel Aviv

The sample trip shows how the pieces fit together. Card receipts put you at Café Sonder by the Carmel Market and Anita Gelato in Neve Tzedek. The taxi receipt fills in what card charges can’t. Pickup in Neve Tzedek at 2:40 p.m., drop-off on Shaul HaMelech Boulevard fourteen minutes later. Two more charges follow, at the Tel Aviv Museum of Art and Schnitt Brewing Company, and the calendar has a concert at Tzavta at 8:30.

![The sample route on the streets of Tel Aviv. An orange dashed line marks the taxi ride from Neve Tzedek to Shaul HaMelech Boulevard.](docs/screenshots/sample-street-map.png)

The orange dashed line shows the taxi ride. The street map in this image uses English labels. [OpenFreeMap](https://openfreemap.org/) · [© OpenMapTiles](https://openmaptiles.org/) · [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

The [downloadable example](https://hayiti-beta.cocoacoati256.chatgpt.site/sample-trip.json) contains all seven stops. Taxi pins show approximate locations. In an empty journal, choose **Try the sample trip**. To add it next to your own trips, open **Sources and import**, choose **Files**, select the JSON and choose **Load trip**.

## Add an event manually

1. Open the web app, or unzip the portable journal and open `Hayiti.html` in your browser.
2. Select a trip or choose **New trip** and enter its name and dates.
3. Pick the day, choose **+ Stop**, and enter a **Place or event name**. Add a time or address if you know it, then choose **Save**.

To add stops from a file, use **Sources and import** to bring in a transaction CSV or a calendar file.

Without signing in, the web app keeps your trips in that browser. Use **Back up trip** to keep an editable copy or move it to another device. Use **Share** to give someone a read-only route. The portable journal saves edits in browser storage when available. You can import, edit and export offline. Saving a stop with an address and no map pin looks the address up and adds the pin. Loading map tiles and looking up addresses require internet access.

On a phone, choose **Stops** to see the day’s visits in order.

<img src="docs/screenshots/sample-stops.png" width="320" alt="Mobile stop list for the sample day, showing card purchases, two ends of a taxi ride and an evening concert.">

## How it finds a route

- **Imports.** Create or select a trip before importing transactions (`.csv`), calendar events (`.ics`) or email (`.eml`). A transaction CSV needs a date and merchant name. A trip backup (`.json`) can open a trip in an empty journal. You can also place a pin by hand.
- **Matching.** hayiti checks the day and source reference before adding a stop. Independent records with matching places, compatible times and compatible addresses can corroborate one visit. Ambiguous matches stay separate for review.
- **Order and distance.** Date, time, ordering rules and location inform the suggested order. Walking estimates use recorded walking segments. Taxi rides and unknown segments are accounted for separately.
- **Source status.** Each requested source has a dated status. Finances distinguishes a disconnected source, missing credit or debit accounts, zero transactions and purchases without a mappable place. Gmail and Calendar can contribute independently.
- **Sharing.** Share a day or trip as a read-only route. The shared version omits notes, photos and source references. The home base is excluded by default. A hosted link can be revoked. A downloaded copy stays with its recipient.

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
| [Object storage](src/server/storage.ts) | Per-user records and conditional writes that prevent lost edits |
| [Tests](test) | Matching, permissions, sharing and an offline Chromium round trip |

## Hosted integration

The build produces browser assets in `dist/web/` and an ES module in `dist/server/app.mjs`. A host calls `handleRequest(request, bindings, verifiedUserId, serveAsset)`. The host authenticates the session or OAuth token and supplies the verified user ID, or `null` for anonymous requests. Configure the sign-in endpoint on that host. Running the portable file needs no account.

Provide a private R2-compatible `BUCKET` and your HTTPS `PUBLISHER_ORIGIN`. To enable hosted sharing, set `HAYITI_SHARE_RELAY` as a host secret. An optional companion journal can set the same secret and use its own origin as `RELAY_ORIGIN` on the publisher. Use the same publisher origin on both hosts. See [the binding types](src/server/storage.ts).

ChatGPT connects to the hosted journal using OAuth and the [MCP connection manifest](directory/mcp.json). With hayiti connected, try asking “Which trips are in my journal?” or “Where did I go on the first day of my trip?” ChatGPT reads trips saved to your hosted account. The portable journal keeps its own copy.

The MCP tools are `list_trips`, `get_day` and `add_trip_stops`. ChatGPT checks the sources you choose and sends hayiti the itinerary details you approve.

## Definition of done

From a checkout with dependencies installed, run the same checks as CI.

```sh
npm run check
npx --no-install playwright-core install chromium
npm run test:browser
```

- `npm run check` verifies the TypeScript source policy, type checking and ESLint, runs the domain and server tests, and builds the portable and hosted artifacts.
- The Chromium test imports the sample Tel Aviv day offline, checks for seven map pins, reloads the journal and verifies that a shareable route is available to download.
- Before merging, the branch must be up to date with `main`, and **Verify hayiti**, **Scan TypeScript** and **CodeQL** must pass on GitHub. [CI workflow](.github/workflows/ci.yml) · [CodeQL workflow](.github/workflows/codeql.yml)

## Contributing

Use a branch and open a pull request. Describe the user-visible behavior and add a regression test for a bug fix. Use fictional trips in issues, pull requests and fixtures.

hayiti's source is licensed under [MIT](LICENSE). Leaflet retains its [upstream license](public/vendor/leaflet-LICENSE). The map uses OpenStreetMap contributors’ data. See [security reporting](SECURITY.md).
