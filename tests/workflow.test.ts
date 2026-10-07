import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { ApplicationFailure, type WorkflowHandle } from '@temporalio/client';
import * as activities from '../src/activities';
import { createOnce, readRecord } from '../src/store';
import { matchClients } from '../src/matching';
import { openingWorkflow, scenarioWorkflow, getOpening, replyToOffer } from '../src/workflows';
import { workflowIdFor, type DemoPreset, type Reply, type ReplyResult, type BookingRecord, type OpeningState, type Scenario } from '../src/types';

type Handle = WorkflowHandle<typeof openingWorkflow>;
let environment: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let directory: string;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'juniper-tests-'));
  process.env.SIMULATION_DATA_DIR = directory;
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('../src/workflows') });
});
after(async () => {
  await environment?.teardown();
  if (directory) await rm(directory, { recursive: true, force: true });
  delete process.env.SIMULATION_DATA_DIR;
});
async function fixture(full = false): Promise<Scenario> {
  const now = await environment.currentTimeMs();
  const startAt = now + 2 * 60 * 60_000;
  const scenario: Scenario = {
    opening: { id: randomUUID(), startAt, service:'Haircut', stylist:'Jamie', durationMinutes:45, responseWindowMs:30_000, simulated:true },
    clients: ['alex','wrong-time','maya','wrong-stylist','wrong-service','wrong-duration',...(full?['jordan','sam']:[])].map((id, index) => ({
      id, name:id, initials:id.slice(0,2), service:id === 'wrong-service'?'Color':'Haircut', stylist:id === 'wrong-stylist'?'Taylor':'Jamie',
      joinedAt:now - (id === 'maya'?10:20-index) * 1000,
      availableFrom:id === 'wrong-time'?startAt+1:startAt-1000,
      availableTo:startAt+60*60_000, durationMinutes:id === 'wrong-duration'?60:45,
    })),
  };
  // Earliest eligible first, even though the input sheet is deliberately unsorted.
  scenario.clients.find(client => client.id === 'maya')!.joinedAt = now - 100_000;
  await createOnce('scenarios', scenario.opening.id, scenario);
  return scenario;
}
async function waitFor(handle: Handle, predicate: (state: OpeningState) => boolean): Promise<OpeningState> {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const state = await environment.client.connection.withDeadline(Date.now() + 5000, () => handle.query(getOpening));
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`State did not arrive: ${JSON.stringify(await handle.query(getOpening))}`);
}
async function run(scenario: Scenario, fn: (handle: Handle) => Promise<void>, overrides: Partial<typeof activities> = {}) {
  const taskQueue = `test-${scenario.opening.id}`;
  const worker = await Worker.create({ connection:environment.nativeConnection, taskQueue, workflowBundle:bundle, activities:{...activities,...overrides} });
  await worker.runUntil(async () => {
    const handle = await environment.client.workflow.start(openingWorkflow, { workflowId:scenario.opening.id, taskQueue, args:[scenario.opening], workflowIdReusePolicy:'REJECT_DUPLICATE' });
    try { await fn(handle); }
    finally { await handle.terminate().catch(() => {}); }
  });
}

test('matching checks service, stylist, availability, duration, then join time', async () => {
  const scenario = await fixture();
  const matched = matchClients(scenario.opening, scenario.clients);
  assert.deepEqual(matched.filter(client=>client.eligible).map(client=>client.id), ['maya','alex']);
  assert.deepEqual(new Set(matched.filter(client=>!client.eligible).map(client=>client.reason)), new Set(['Time mismatch','Stylist mismatch','Service mismatch','Duration mismatch']));
});

test('durable timeout advances; late acceptance cannot steal the next offer; repeat booking is idempotent', async () => {
  const scenario = await fixture();
  await run(scenario, async handle => {
    const first = (await waitFor(handle, state=>state.offers[0]?.status==='active')).offers[0];
    assert.equal(first.clientId,'maya');
    await environment.sleep('31 seconds');
    const second = (await waitFor(handle, state=>state.offers[1]?.status==='active')).offers[1];
    assert.equal(second.clientId,'alex');
    const late = await handle.executeUpdate(replyToOffer,{args:[{offerId:first.id,clientId:'maya',response:'accept'}]});
    assert.equal(late.code,'expired');
    const reply = {offerId:second.id,clientId:'alex',response:'accept' as const};
    const accepted = await handle.executeUpdate(replyToOffer,{args:[reply]});
    assert.equal(accepted.code,'confirmed');
    assert.deepEqual(await handle.executeUpdate(replyToOffer,{args:[reply]}),accepted);
    const state = await handle.query(getOpening);
    assert.equal(state.phase,'booked');
    assert.equal(state.offers.filter(offer=>offer.status==='accepted').length,1);
    assert.equal(state.events.filter(event=>event.text==='Appointment confirmed').length,1);
    assert.equal(state.offers[0].late,true);
    assert.equal((await readRecord<BookingRecord>('bookings',scenario.opening.id))?.clientId,'alex');
  });
});

test('declines advance in order and stop when eligible clients are exhausted', async () => {
  const scenario = await fixture();
  await run(scenario,async handle=>{
    for (const [index,clientId] of ['maya','alex'].entries()) {
      const offer=(await waitFor(handle,state=>state.offers[index]?.status==='active')).offers[index];
      assert.equal(offer.clientId,clientId);
      assert.equal((await handle.executeUpdate(replyToOffer,{args:[{offerId:offer.id,clientId,response:'decline'}]})).code,'declined');
    }
    const state=await waitFor(handle,state=>state.phase==='exhausted');
    assert.equal(state.offers.length,2);
    assert.equal(await readRecord('bookings',scenario.opening.id),undefined);
  });
});

test('concurrent acceptance/decline and wrong-client replies cannot create competing bookings',async()=>{
  const scenario=await fixture();
  await run(scenario,async handle=>{
    const offer=(await waitFor(handle,state=>state.offers[0]?.status==='active')).offers[0];
    assert.equal((await handle.executeUpdate(replyToOffer,{args:[{offerId:offer.id,clientId:'alex',response:'accept'}]})).code,'invalid_offer');
    const replies=await Promise.all(['accept','decline'].map(response=>handle.executeUpdate(replyToOffer,{args:[{offerId:offer.id,clientId:'maya',response:response as 'accept'|'decline'}]})));
    assert.equal(replies.filter(reply=>reply.accepted).length,1);
    const state=await handle.query(getOpening);
    assert.ok(state.offers.filter(item=>item.status==='accepted').length<=1);
  });
});

test('Activity retry after sending produces only one SMS record',async()=>{
  const scenario=await fixture();let attempts=0;
  await run(scenario,async handle=>{
    const offer=(await waitFor(handle,state=>state.offers[0]?.status==='active')).offers[0];
    assert.equal(attempts,2);
    const records=(await readdir(path.join(directory,'messages'))).filter(name=>name.startsWith(scenario.opening.id));
    assert.deepEqual(records,[`${offer.id}.json`]);
  },{sendOffer:async message=>{const result=await activities.sendOffer(message);if(++attempts===1)throw ApplicationFailure.retryable('Simulated crash after delivery');return result;}});
});

test('booking failure holds the opening for staff attention rather than offering it again',async()=>{
  const scenario=await fixture();
  await run(scenario,async handle=>{
    const offer=(await waitFor(handle,state=>state.offers[0]?.status==='active')).offers[0];
    const result=await handle.executeUpdate(replyToOffer,{args:[{offerId:offer.id,clientId:'maya',response:'accept'}]});
    assert.equal(result.code,'booking_failed');
    const state=await handle.query(getOpening);
    assert.equal(state.phase,'attention');assert.equal(state.offers.length,1);
  },{bookOpening:async()=>{throw ApplicationFailure.nonRetryable('Simulated provider conflict');}});
});

test('restarting the Worker restores the timer and progresses without browser participation',async()=>{
  const scenario=await fixture();const taskQueue=`recovery-${scenario.opening.id}`;
  const settings={connection:environment.nativeConnection,taskQueue,workflowBundle:bundle,activities,maxCachedWorkflows:0};
  const firstWorker=await Worker.create(settings);const firstRun=firstWorker.run();
  const handle=await environment.client.workflow.start(openingWorkflow,{workflowId:scenario.opening.id,taskQueue,args:[scenario.opening]});
  try{
    const first=(await waitFor(handle,state=>state.offers[0]?.status==='active')).offers[0];
    firstWorker.shutdown();await firstRun;
    await environment.sleep('31 seconds');
    const recoveredWorker=await Worker.create(settings);
    await recoveredWorker.runUntil(async()=>{
      const state=await waitFor(handle,state=>state.offers[1]?.status==='active');
      assert.equal(state.offers[0].id,first.id);assert.equal(state.offers[0].status,'expired');assert.equal(state.offers[1].clientId,'alex');
      assert.equal(state.events.filter(event=>event.text==='Offer sent'&&event.person==='maya').length,1);
      await handle.terminate();
    });
  }finally{if(firstWorker.getState()==='RUNNING'){firstWorker.shutdown();await firstRun;}await handle.terminate().catch(()=>{});}
});

test('the simulated booking store prevents two different offer IDs from reserving one opening',async()=>{
  const openingId=randomUUID();
  const results=await Promise.allSettled(['one','two'].map(offerId=>activities.bookOpening({openingId,offerId,clientId:offerId})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
});

test('the real same-day policy holds for fifteen minutes rather than the demo duration',async()=>{
  const scenario=await fixture();scenario.opening.responseWindowMs=900_000;
  await run(scenario,async handle=>{
    const first=(await waitFor(handle,state=>state.offers[0]?.status==='active')).offers[0];
    assert.equal(first.expiresAt-first.sentAt,900_000);
    await environment.sleep('14 minutes');
    assert.equal((await handle.query(getOpening)).offers[0].status,'active');
    await environment.sleep('61 seconds');
    const state=await waitFor(handle,state=>state.offers[1]?.status==='active');
    assert.equal(state.offers[0].status,'expired');
  });
});

test('a permanent SMS failure advances without exposing an undelivered offer in the inbox',async()=>{
  const scenario=await fixture();
  await run(scenario,async handle=>{
    const state=await waitFor(handle,state=>state.offers[1]?.status==='active');
    assert.equal(state.offers[0].status,'delivery_failed');assert.equal(state.offers[0].delivered,false);
    assert.equal(state.offers[1].clientId,'alex');
  },{sendOffer:async message=>{if(message.clientId==='maya')throw ApplicationFailure.nonRetryable('Simulated invalid phone number');return activities.sendOffer(message);}});
});

test('openings outside 48 hours and missing response policies do not contact clients',async()=>{
  for(const mode of ['outside','missing']){
    const scenario=await fixture();
    if(mode==='outside')scenario.opening.startAt+=49*60*60_000;
    else scenario.opening.responseWindowMs=undefined as unknown as number;
    await run(scenario,async handle=>{
      const state=await waitFor(handle,state=>state.phase==='attention');
      assert.equal(state.offers.length,0);
    });
  }
});


for (const preset of ['match','queue','saturday','exhausted'] as DemoPreset[]) {
  test(`automated customer scenario: ${preset}`,async()=>{
    const scenario=await fixture(true);
    scenario.opening.demoPreset=preset;scenario.opening.responseWindowMs=10_000;
    const taskQueue=`scenario-${scenario.opening.id}`;
    const worker=await Worker.create({connection:environment.nativeConnection,taskQueue,workflowBundle:bundle,activities:{
      ...activities,
      readDemoOpening:async(id:string)=>environment.client.workflow.getHandle(workflowIdFor(id)).query<OpeningState>('getOpening'),
      sendDemoReply:async(id:string,reply:Reply)=>environment.client.workflow.getHandle(workflowIdFor(id)).executeUpdate<ReplyResult,[Reply]>('replyToOffer',{updateId:`${reply.offerId}-${reply.clientId}-${reply.response}`,args:[reply]}),
    }});
    await worker.runUntil(async()=>{
      const handle=await environment.client.workflow.start(scenarioWorkflow,{workflowId:`demo-${scenario.opening.id}`,taskQueue,args:[scenario.opening]});
      const child=environment.client.workflow.getHandle< typeof openingWorkflow >(workflowIdFor(scenario.opening.id));
      try {
        const result=await handle.result();
        assert.equal(result.status,'complete');
        const state=await child.query(getOpening);
        const statuses=state.offers.map(offer=>offer.status);
        if(preset==='match'){assert.deepEqual(statuses,['accepted']);assert.equal(state.offers[0].clientId,'maya');}
        if(preset==='queue'){assert.deepEqual(statuses,['declined','expired','accepted']);assert.equal(state.offers[2].clientId,'jordan');}
        if(preset==='saturday'){assert.deepEqual(statuses,['expired','accepted']);assert.equal(state.offers[0].late,true);assert.equal(state.offers[1].clientId,'alex');}
        if(preset==='exhausted'){assert.deepEqual(statuses,['declined','expired','declined','expired']);assert.equal(state.phase,'exhausted');}
        assert.ok(state.offers.every(offer=>['maya','alex','jordan','sam'].includes(offer.clientId)));
        assert.ok(state.offers.filter(offer=>offer.status==='accepted').length<=1);
      }finally{await handle.terminate().catch(()=>{});await child.terminate().catch(()=>{});}
    });
  });
}
