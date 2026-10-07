import { NativeConnection, Worker } from "@temporalio/worker";

import * as activities from './activities';
import * as demoActivities from './demo-activities';
import { TASK_QUEUE } from './types';

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    activities: { ...activities, readDemoOpening: demoActivities.readDemoOpening, sendDemoReply: demoActivities.sendDemoReply },
    workflowsPath: require.resolve("./workflows"),
  });
  console.log("Worker is polling the juniper-waitlist task queue.");
  try { await worker.run(); }
  finally { await Promise.all([connection.close(), demoActivities.closeDemoConnection()]); }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

