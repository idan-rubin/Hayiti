import { sources, reportSources, statesBySource } from '../domain/core.ts';
export const dailyGooglePinPreviewLimit = 20;
const stopShape = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Public place label. Use a traveler-approved market or area when the branch is unknown. For a purchase with card evidence, omit an unidentified or withheld merchant name.'
    },
    date: {
      type: 'string',
      description: 'Local YYYY-MM-DD'
    },
    address: {
      type: 'string'
    },
    time: {
      type: 'string',
      description: 'Known local HH:mm only'
    },
    captureTime: {
      type: 'string',
      description: 'Optional local photo capture time HH:mm:ss, optionally with milliseconds. Use the same local date and minute as the stop.'
    },
    xy: {
      type: 'array',
      items: {
        type: 'number'
      },
      description: 'Latitude and longitude of the supported location or of a traveler-approved general area.'
    },
    approx: {
      type: 'boolean',
      description: 'True when the pin represents a general area or approximate location.'
    },
    notes: {
      type: 'string'
    },
    reviewReason: {
      type: 'string',
      maxLength: 240,
      description: 'For an uncertain entry, give the traveler one short, specific reason it needs review. Mention only the missing or conflicting evidence, without personal identifiers.'
    },
    sources: {
      type: 'array',
      items: {
        type: 'string',
        enum: sources
      }
    },
    refs: {
      type: 'array',
      items: {
        type: 'string'
      },
      description: 'Short opaque references used for duplicate detection. Exclude personal identifiers, booking codes, credentials, and card numbers.'
    },
    kind: {
      type: 'string',
      enum: ['visit', 'uncertain', 'remote', 'pickup', 'dropoff'],
      description: 'Use visit for a confirmed in-person purchase even without a merchant, branch or coordinates. Use remote for an online purchase and uncertain when physical attendance is unknown.'
    },
    count: {
      type: 'integer'
    },
    slot: {
      type: 'string',
      enum: ['morning', 'midday', 'evening', 'night']
    }
  },
  required: ['date', 'sources', 'refs']
};
const checkSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Observed outcomes for requested sources over the full trip dates. Use no_accounts only after checking for accounts with purchase history (credit or debit). Use no_transactions only after a completed search; no_places means purchases found but none mappable. Use partial for incomplete coverage. Omit unchecked sources.',
  properties: Object.fromEntries(reportSources.map(key => [key, {
    type: 'string',
    enum: statesBySource[key]
  }]))
};
export const tools = [{
  name: 'list_trips',
  description: 'List the signed-in traveler’s trips and date ranges.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {}
  }
}, {
  name: 'get_day',
  description: `Read one day of an owned trip and its revision for reconciling visits and correcting a stop. stops includes private unlocated and off-route evidence. routeStopIds gives the ordered mapped stops, excluding the origin, for set_day_routes. googlePins previews up to ${dailyGooglePinPreviewLimit} bookmarks and googlePinCount gives the total. Fetch the rest with list_google_pins using the same date and an offset equal to the number already received.`,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {
      tripId: {
        type: 'string'
      },
      date: {
        type: 'string'
      }
    },
    required: ['tripId', 'date']
  }
}, {
  name: 'list_google_pins',
  description: 'Read up to 200 saved Google Pins with the total for the selection. Supply date to read only that day. Omit date to include the whole trip and unassigned pins. Pass offset to continue the same selection.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      tripId: { type: 'string' },
      date: { type: 'string', format: 'date', description: 'Assigned trip day in local YYYY-MM-DD.' },
      offset: { type: 'integer', minimum: 0, description: 'Number of matching pins to skip. Omit to start at the first pin.' }
    },
    required: ['tripId']
  }
}, {
  name: 'restore_google_pin',
  description: 'Restore one previously removed Google Maps bookmark only when the traveler explicitly asks to bring it back. Supply its original stable ID and verified name and coordinates from the source. The restored pin stays private and outside the itinerary, walking distance and public shares. A retry is a no-op. Use add_trip_stops for ordinary imports; never use this tool to bypass previouslyRemoved automatically.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      tripId: { type: 'string' },
      pin: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 180 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          xy: { ...stopShape.properties.xy, minItems: 2, maxItems: 2 },
          date: { type: 'string', description: 'Assigned trip day in local YYYY-MM-DD. Omit when unknown.' },
          savedAt: { type: 'string', description: 'Optional source-reported original save date or ISO timestamp with offset.' }
        },
        required: ['id', 'name', 'xy']
      }
    },
    required: ['tripId', 'pin']
  }
}, {
  name: 'add_trip_stops',
  description: 'Create a dated trip, append visits, or save Google Maps bookmarks in googlePins. For a bookmarks-only import, send stops: []. Reuse the original bookmark ID so removals are respected; previouslyRemoved counts bookmarks the traveler chose to leave out. Only an explicit traveler request to bring one back permits restore_google_pin with its original pin data. Supply a title, start and end dates for a new trip. Save only the place and itinerary details approved by the traveler. Repeating a stop with the same source reference on the same day skips the duplicate.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true
  },
  inputSchema: {
    type: 'object',
    properties: {
      tripId: {
        type: 'string'
      },
      title: {
        type: 'string'
      },
      start: {
        type: 'string'
      },
      end: {
        type: 'string'
      },
      home: {
        type: 'string'
      },
      homeXY: {
        ...stopShape.properties.xy,
        description: 'Optional verified latitude and longitude of the traveler-approved home base for a new trip.',
        minItems: 2,
        maxItems: 2
      },
      googlePins: {
        type: 'array', maxItems: 200,
        description: 'Saved places independent of all visits and routes. Reuse the same opaque ID for a Google place on every import. Sending a saved ID again with a corrected name or location updates it. A place at [0, 0] is refused.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 180 },
            name: { type: 'string', minLength: 1, maxLength: 160 },
            xy: { ...stopShape.properties.xy, minItems: 2, maxItems: 2 },
            date: { type: 'string', description: 'Assigned trip day (local YYYY-MM-DD), from the traveler or a verified local save date. Omit when unknown. A day outside the trip is not kept, and the reply counts it in datesOutsideTrip.' },
            savedAt: { type: 'string', description: 'Optional source-reported date saved, YYYY-MM-DD or ISO timestamp with offset. Omit for a modification, export, or visit date. Provide date separately if a UTC timestamp can be converted to a verified local day.' }
          },
          required: ['id', 'name', 'xy']
        }
      },
      sourceChecks: checkSchema,
      stops: {
        type: 'array',
        items: stopShape,
        maxItems: 200
      }
    },
    required: ['tripId', 'stops']
  }
}, {
  name: 'correct_stop_location',
  description: 'Correct one existing visit or uncertain record using the stop ID and revision from get_day. Save an approved address even when it has no known coordinates. For an existing mapped address being replaced, also supply its corrected point or null. Explicitly confirm a visit only when the traveler establishes that it occurred in person. Read the day again and route any affected legs.',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      tripId: { type: 'string' },
      date: { type: 'string', format: 'date' },
      stopId: { type: 'string' },
      expectedRevision: { type: 'string', description: 'Current journal revision from get_day.' },
      name: { type: 'string', minLength: 1, maxLength: 160, description: 'Optional corrected display name approved by the traveler.' },
      address: { type: 'string', maxLength: 400, description: 'Verified branch address. An empty string clears it. When switching an exact pin to approximate, omit this field or send an empty string; a non-empty value is rejected. Later edits preserve private addresses unless explicitly changed. Shares omit approximate addresses.' },
      xy: { anyOf: [{ ...stopShape.properties.xy, minItems: 2, maxItems: 2 }, { type: 'null' }], description: 'Approved branch or area coordinates in latitude, longitude order. Null removes the saved coordinates.' },
      approx: { type: 'boolean', description: 'True for an area-level location. Switching an exact pin to approximate requires a different, traveler-approved area point and clears the previous street address. Omit address or send an empty string during the switch. Shares preserve the saved place label and omit its address.' },
      confirmVisit: { type: 'boolean', description: 'True when the traveler confirms physical attendance. Supplying an address alone preserves the existing classification.' }
    },
    required: ['tripId', 'date', 'stopId', 'expectedRevision']
  }
}, {
  name: 'set_day_routes',
  description: 'Save the approved stop order and network routes between adjacent stops in one update. Read get_day before supplying an order; it may be omitted for routing-only writes. Default to an estimated pedestrian route. Use road directions for a known taxi leg. Preserve legs with confirmed travel by other modes and omit unavailable directions. Supply same only for coincident stops. Use gap and an empty line only for an explicitly requested gap. Read get_day to verify the saved modes and vertex counts.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true
  },
  inputSchema: {
    type: 'object',
    properties: {
      tripId: { type: 'string' },
      date: { type: 'string', description: 'Local YYYY-MM-DD' },
      expectedRevision: { type: 'string', description: 'Current get_day revision. Required when correcting a misclassified taxi ride.' },
      order: {
        type: 'object', additionalProperties: false,
        description: 'Both lists contain every ID from get_day.routeStopIds exactly once. Only mapped visits, pickups and drop-offs belong in this order. Preserve each taxi pair. Read the day again if its order has changed.',
        properties: {
          previous: { type: 'array', maxItems: 6500, uniqueItems: true, items: { type: 'string' }, description: 'Current routeStopIds from get_day.' },
          next: { type: 'array', maxItems: 6500, uniqueItems: true, items: { type: 'string' }, description: 'Proposed order of the same IDs.' }
        },
        required: ['previous', 'next']
      },
      routes: {
        type: 'array', maxItems: 200,
        items: {
          type: 'object',
          properties: {
            a: { type: 'string', description: 'Start stop ID, or base for the implicit home origin.' },
            b: { type: 'string', description: 'Next on-route stop ID for this day.' },
            type: { type: 'string', enum: ['walk', 'taxi', 'same', 'gap'] },
            correctTaxi: { type: 'boolean', description: 'Set true only when the traveler explicitly corrects this exact taxi ride to a walk or a gap. It also converts dedicated pickup and drop-off roles to visits. Keep the pair adjacent for this correction, then reorder separately if requested.' },
            m: { type: 'number', minimum: 0, description: 'Optional network distance in metres; defaults to measured line length.' },
            line: {
              type: 'array', maxItems: 1000,
              description: 'Network geometry in travel order. Each point is [latitude, longitude]. Leave empty for gap or same. Never draw a direct line as a substitute for routing.',
              items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }
            }
          },
          required: ['a', 'b', 'type', 'line']
        }
      }
    },
    required: ['tripId', 'date', 'routes']
  }
}];
