/**
 * The printer's settings tab.
 *
 * Registering here is what puts the NiimBot under `/backend/integrations`: the
 * installed `integrations` module renders the form from `credentials.fields`, stores
 * what is saved encrypted under the tenant DEK, and runs `healthCheck.service` behind
 * the "test connection" button. No page in this module.
 *
 * One honest caveat, recorded so nobody has to rediscover it. `portPath` is a property
 * of the host process's Bluetooth pairing, not of the tenant — it describes the machine
 * the app runs on. It lives in a tenant-scoped store here because that is where an
 * editable settings form can put it, which is correct while the app runs on the same
 * machine as the printer and stops being correct the day it does not. The seam that
 * fixes that is `SerialTransport` (`lib/types.ts`): pointing this field at an HTTP
 * endpoint served by a process next to the printer is a new transport, not a new
 * contract here.
 */
import {
  type IntegrationBundle,
  type IntegrationDefinition,
} from '@open-mercato/shared/modules/integrations/types'

export const LABEL_PRINTER_INTEGRATION_ID = 'label_printing.niimbot'

export const integration: IntegrationDefinition = {
  id: LABEL_PRINTER_INTEGRATION_ID,
  title: 'NiimBot B1 label printer',
  description:
    'Serial label printer used for product and pallet labels. Leave the port empty to '
    + 'switch printing off; every other field falls back to the deployment\'s own NIIMBOT_* '
    + 'configuration when left blank.',
  category: 'hardware',
  icon: 'printer',
  version: '0.1.0',
  author: 'Commerce Weavers',
  license: 'MIT',
  tags: ['niimbot', 'label', 'printer', 'serial', 'barcode'],
  credentials: {
    fields: [
      {
        key: 'portPath',
        label: 'Serial port',
        // Not a secret: a device path is not a credential, and marking it one would
        // hide it behind the masking the form applies to `secret` fields.
        type: 'text',
        required: false,
        placeholder: '/dev/tty.B1-XXXXXXXX',
        helpText:
          'Device the printer is paired on. Empty switches printing off and the API answers 503.',
      },
      {
        key: 'density',
        label: 'Print darkness',
        // A select rather than free text: the head has exactly these five levels, and
        // the form can refuse a typo that free text would only surface at print time.
        type: 'select',
        required: false,
        options: [
          { value: '1', label: '1 — lightest' },
          { value: '2', label: '2' },
          { value: '3', label: '3 — default' },
          { value: '4', label: '4' },
          { value: '5', label: '5 — darkest' },
        ],
        helpText: 'Higher is darker and slower. Leave unset to keep the deployment default.',
      },
      {
        key: 'labelType',
        label: 'Label type',
        type: 'select',
        required: false,
        options: [
          { value: '1', label: '1 — with gaps (default)' },
          { value: '2', label: '2 — black mark' },
          { value: '3', label: '3 — continuous' },
        ],
        helpText: 'How the printer finds the edge of each label on the roll.',
      },
      {
        key: 'labelWidth',
        label: 'Label width in dots',
        type: 'text',
        required: false,
        placeholder: '384',
        helpText:
          'Capped at 400 by the print head and must be divisible by 8. 384 is 50mm on the B1.',
      },
      {
        key: 'labelHeight',
        label: 'Label height in dots',
        type: 'text',
        required: false,
        placeholder: '230',
        helpText: 'Bounded only by the stock. 230 is 30mm on the B1.',
      },
      {
        key: 'jobTimeoutMs',
        label: 'Job timeout in milliseconds',
        type: 'text',
        required: false,
        placeholder: '60000',
        helpText:
          'How long one label may take before the job is abandoned. A measured B1 job takes '
          + 'about 27 seconds, so leave room above that.',
      },
    ],
  },
  healthCheck: { service: 'labelPrinterHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
