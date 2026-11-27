import { sources, reportSources, statesBySource } from '../domain/core.ts';
export const dailyGooglePinPreviewLimit = 20;
const stopShape = {
  type: 'object',
  properties: {
    name: {
      type: 'string'
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
      description: 'Verified latitude, longitude only'
    },
    notes: {
      type: 'string'
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
      enum: ['visit', 'uncertain', 'remote', 'pickup', 'dropoff']
    },
    count: {
      type: 'integer'
    },
    slot: {
      type: 'string',
      enum: ['morning', 'midday', 'evening', 'night']
    }
  },
  required: ['name', 'date', 'sources', 'refs']
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
  description: `Read one day of an owned trip for reconciling events and visits. googlePins previews up to ${dailyGooglePinPreviewLimit} bookmarks and googlePinCount gives the total. Fetch the rest with list_google_pins using the same date and an offset equal to the number already received.`,
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
  name: 'add_trip_stops',
  description: 'Create a dated trip, append visits, or save Google Maps bookmarks in googlePins. For a bookmarks-only import, send stops: []. Reuse the original bookmark ID so removals are respected; previouslyRemoved counts bookmarks the traveler chose to leave out. Supply a title, start and end dates for a new trip. Save only the place and itinerary details approved by the traveler. Repeating a stop with the same source reference on the same day skips the duplicate.',
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
  name: 'set_day_routes',
  description: 'Save network routes between adjacent stops on a saved day. Default to an estimated pedestrian route. Use road directions for a known taxi leg. Preserve legs with confirmed travel by other modes and omit unavailable directions. Supply same only for coincident stops. Use gap and an empty line only for an explicitly requested gap. Read get_day to verify the saved modes and vertex counts.',
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
      routes: {
        type: 'array', maxItems: 200,
        items: {
          type: 'object',
          properties: {
            a: { type: 'string', description: 'Start stop ID, or base for the implicit home origin.' },
            b: { type: 'string', description: 'Next on-route stop ID for this day.' },
            type: { type: 'string', enum: ['walk', 'taxi', 'same', 'gap'] },
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
