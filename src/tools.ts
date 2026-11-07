import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { executeOperation, maestroFlowSchema, type Operation, type OperationInput } from './core/service.js';

const selector = z.object({ key: z.string().optional(), text: z.string().optional(), description: z.string().optional(), quantity: z.string().optional(), index: z.number().int().optional(), point: z.string().optional(), container: z.any().optional() });
const step = z.object({ action: z.enum(['tap', 'input', 'hideKeyboard', 'scroll', 'back', 'assertVisible', 'assertNotVisible', 'wait']), selector: selector.optional(), value: z.string().optional(), previous: selector.optional(), locale: z.string().optional() });
const journey = z.object({ title: z.string(), anchor: selector, initialLocale: z.string().optional(), localePreconditions: z.record(z.string(), z.array(step)).optional(), preconditions: z.array(step).optional(), steps: z.array(step) });
export const toolInputSchema = z.object({
  projectRoot: z.string().optional(), config: z.string().optional(), runId: z.string().optional(),
  index: z.string().optional(), hierarchy: z.array(z.string()).optional(), flow: z.string().optional(),
  locale: z.array(z.string()).optional(), appId: z.string().optional(), journey: z.union([z.string(), journey]).optional(),
  output: z.string().optional(), maestroVersion: z.string().optional(), serial: z.string().optional(), suite: z.boolean().optional(),
  screenAnchor: z.string().optional(), selectorRepair: z.object({ old: z.string(), replacement: z.string() }).optional(), maestro: z.string().optional(), adb: z.string().optional(),
  emuLab: z.object({ databasePath: z.string(), leaseId: z.string(), packageName: z.string() }).optional(),
});

export const configSection = 'maestroFlow';
export const configSectionSchema = maestroFlowSchema;
export const supportedSchemaMajors = [1];
export const doctor = (input: OperationInput = {}) => executeOperation('doctor', input);

export function toolDefinitions() {
  const inputSchema = zodToJsonSchema(toolInputSchema, { $refStrategy: 'none' });
  return (['index', 'lint', 'generate', 'run', 'doctor'] as Operation[]).map(operation => ({
    name: `maestro_flow_${operation}`,
    description: `${operation} Maestro flows`,
    inputSchema,
    handler: (input: OperationInput = {}) => executeOperation(operation, input),
  }));
}
