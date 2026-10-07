import { Client, Connection } from '@temporalio/client';
import { workflowIdFor, type OpeningState, type Reply, type ReplyResult } from './types';

// These Activities play fictional clients. They use the exact same Query and
// Update contracts as the browser; they never modify the booking state directly.
let connection: Promise<Connection> | undefined;
async function client(): Promise<Client> {
  connection ??= Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' })
    .catch(error => { connection = undefined; throw error; });
  return new Client({ connection: await connection, namespace: 'default' });
}
export async function readDemoOpening(openingId: string): Promise<OpeningState> {
  const temporal = await client();
  return temporal.connection.withDeadline(Date.now() + 5000, () => temporal.workflow.getHandle(workflowIdFor(openingId)).query<OpeningState>('getOpening'));
}
export async function sendDemoReply(openingId: string, reply: Reply): Promise<ReplyResult> {
  const temporal = await client();
  return temporal.connection.withDeadline(Date.now() + 12_000, () => temporal.workflow.getHandle(workflowIdFor(openingId)).executeUpdate<ReplyResult, [Reply]>('replyToOffer', {
    updateId: `${reply.offerId}-${reply.clientId}-${reply.response}`,
    args: [reply],
  }));
}

export async function closeDemoConnection(): Promise<void> {
  if (connection) { await (await connection).close(); connection = undefined; }
}
