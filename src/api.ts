import path from 'node:path';
import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import express, { type NextFunction, type Request, type Response } from 'express';
import { matchClients } from './matching';
import { currentScenario, newScenario } from './scenario';
import { readRecord } from './store';
import { DEMO_PRESETS, TASK_QUEUE, workflowIdFor, type DemoPreset, type DemoRunState, type OpeningState, type ReplyResult, type Scenario } from './types';

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
let clientPromise: Promise<Client> | undefined;
async function temporal(): Promise<Client> {
  clientPromise ??= Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' })
    .then(connection => new Client({ connection, namespace: 'default' }))
    .catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
function preview(scenario: Scenario): OpeningState {
  return { opening: scenario.opening, workflowId: workflowIdFor(scenario.opening.id), phase: scenario.opening.demoPreset && scenario.opening.demoPreset !== 'manual' ? 'loading' : 'open', clients: matchClients(scenario.opening, scenario.clients), offers: [], events: [{ text: 'Opening added', person: 'Simulated Square', at: scenario.opening.startAt - 2 * 60 * 60_000 }] };
}
async function getState(scenario: Scenario): Promise<OpeningState> {
  const client = await temporal();
  try {
    const state = await client.connection.withDeadline(Date.now() + 4000, () => client.workflow.getHandle(workflowIdFor(scenario.opening.id)).query<OpeningState>('getOpening'));
    if (scenario.opening.demoPreset && scenario.opening.demoPreset !== 'manual') {
      state.demo = await client.connection.withDeadline(Date.now() + 4000, () => client.workflow.getHandle(`demo-${scenario.opening.id}`).query<DemoRunState>('getDemoRun'));
    }
    return state;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return preview(scenario);
    throw error;
  }
}
async function scenarioFor(id: string): Promise<Scenario | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return undefined;
  return readRecord<Scenario>('scenarios', id);
}
app.get('/api/demo', async (_request, response) => {
  response.set('Cache-Control', 'no-store').json(await getState(await currentScenario()));
});
app.post('/api/demo/new', async (request, response) => {
  const preset = request.body?.preset ?? 'manual';
  if (!DEMO_PRESETS.includes(preset)) { response.status(400).json({ error: 'Choose a supported scenario.' }); return; }
  const scenario = await newScenario(preset as DemoPreset);
  if (preset !== 'manual') {
    const client = await temporal();
    await client.workflow.start('scenarioWorkflow', {
      workflowId: `demo-${scenario.opening.id}`, taskQueue: TASK_QUEUE,
      workflowIdReusePolicy: 'REJECT_DUPLICATE', args: [scenario.opening],
    });
  }
  response.status(201).json(await getState(scenario));
});
app.post('/api/openings/:id/start', async (request, response) => {
  const scenario = await scenarioFor(request.params.id);
  if (!scenario) { response.status(404).json({ error: 'Opening not found' }); return; }
  if (scenario.opening.demoPreset && scenario.opening.demoPreset !== 'manual') { response.status(409).json({ error: 'This opening is controlled by an automated scenario.' }); return; }
  const windowMs = request.body?.responseWindowMs;
  if (![30_000, 900_000].includes(windowMs)) { response.status(400).json({ error: 'Choose the 30-second demo or 15-minute response window.' }); return; }
  const client = await temporal();
  let created = true;
  try {
    await client.workflow.start('openingWorkflow', {
      workflowId: workflowIdFor(scenario.opening.id), taskQueue: TASK_QUEUE,
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [{ ...scenario.opening, responseWindowMs: windowMs }],
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    created = false;
  }
  response.status(created ? 201 : 200).json(await getState(scenario));
});
app.post('/api/openings/:id/reply', async (request, response) => {
  const scenario = await scenarioFor(request.params.id);
  if (!scenario) { response.status(404).json({ error: 'Opening not found' }); return; }
  const { offerId, clientId, response: reply } = request.body ?? {};
  if (typeof offerId !== 'string' || offerId.length > 160 || typeof clientId !== 'string' || !scenario.clients.some(client => client.id === clientId) || !['accept', 'decline'].includes(reply)) {
    response.status(400).json({ error: 'Invalid offer reply' }); return;
  }
  const client = await temporal();
  const result = await client.connection.withDeadline(Date.now() + 12_000, () => client.workflow.getHandle(workflowIdFor(scenario.opening.id)).executeUpdate<ReplyResult, [typeof request.body]>('replyToOffer', {
    updateId: `${offerId}-${clientId}-${reply}`,
    args: [{ offerId, clientId, response: reply }],
  }));
  response.json({ result, state: await getState(scenario) });
});
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (error instanceof SyntaxError) { response.status(400).json({ error: 'Invalid JSON request' }); return; }
  if (error instanceof WorkflowNotFoundError) { response.status(409).json({ error: 'This workflow is no longer accepting replies.' }); return; }
  response.status(503).json({ error: 'Temporal is unavailable or the worker is restarting. Retry to check the recorded result.' });
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`Juniper Salon: http://localhost:${port}`));
