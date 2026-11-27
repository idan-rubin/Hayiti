import { sources, reportSources, statesBySource } from '../domain/core.ts';
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
  description: 'Read one day of an owned trip for reconciling events and visits.',
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
  name: 'add_trip_stops',
  description: 'Create a dated trip or append stops the traveler has chosen to save. Supply a title, start and end dates for a new trip. Save only the place and itinerary details approved by the traveler. Repeating a stop with the same source reference on the same day skips the duplicate.',
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
      sourceChecks: checkSchema,
      stops: {
        type: 'array',
        items: stopShape,
        maxItems: 200
      }
    },
    required: ['tripId', 'stops']
  }
}];
