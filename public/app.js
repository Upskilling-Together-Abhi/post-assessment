let clients = [];
let state;
let currentView = 'staff';
let windowMs = 30_000;
let selectedPreset = 'saturday';
let presetInitialized = false;
const presets = {saturday:'Saturday, resolved',match:'The right client',queue:'The queue moves itself',exhausted:'Nobody takes it',manual:'Manual walkthrough'};
let busy = false;
let refreshing = false;
let generation = 0;
let fingerprint = '';
let noticeTimer;
const app = document.querySelector('#app');
const view = document.querySelector('#view');
const getClient = id => clients.find(client => client.id === id);
const time = timestamp => new Date(timestamp).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
const clockTime = timestamp => new Date(timestamp).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',second:'2-digit'});
const date = timestamp => new Date(timestamp).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function notify(message) {
  document.querySelector('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => document.querySelector('#notice').textContent = '', 6000);
}
async function request(url, body) {
  const response = await fetch(url, { method:body ? 'POST':'GET', headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)}:{}), signal:AbortSignal.timeout(16000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Retry.');
  return data;
}
function applyState(data) {
  const serialized = JSON.stringify(data);
  if (serialized === fingerprint) return;
  fingerprint = serialized;
  state = {...data, appointment:data.opening.startAt};
  if (!presetInitialized) { selectedPreset=data.opening.demoPreset&&data.opening.demoPreset!=='manual'?data.opening.demoPreset:'saturday';presetInitialized=true; }
  clients = data.clients.map(client => ({...client, name:escapeHTML(client.name), service:escapeHTML(client.service), stylist:escapeHTML(client.stylist), joined:`${date(client.joinedAt)} · ${time(client.joinedAt)}`}));
  state.events = data.events.map(event => ({...event, text:escapeHTML(event.text), person:escapeHTML(event.person)}));
  if (currentView !== 'staff' && !getClient(currentView)) currentView = 'staff';
  render();
}
async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  const version = generation;
  try {
    const data = await request('/api/demo');
    if (version === generation) { applyState(data); document.querySelector('#connection').hidden = true; }
  } catch (error) {
    document.querySelector('#connection').hidden = false;
    if (!state) app.innerHTML = '<button data-action="retry">Retry connection</button>';
  } finally { refreshing = false; }
}
function autoplay() { return state.opening.demoPreset && state.opening.demoPreset !== 'manual' && (!state.demo || state.demo.status === 'running'); }
function activeOffer() { return state.offers.find(offer => ['sending','active','accepting'].includes(offer.status)); }
function badge(text,tone=''){return `<span class="badge ${tone}">${text}</span>`;}
function remaining(offer){const seconds=Math.max(0,Math.ceil((offer.expiresAt-Date.now())/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function phaseBadge(){return ({open:badge('Open'),loading:badge('Matching'),offering:badge('Offer active','amber'),booking:badge('Booking','amber'),booked:badge('Booked','green'),exhausted:badge('Unfilled','red'),attention:badge('Needs attention','red'),closed:badge('Closed')})[state.phase];}
function scenarioProgress() {
 const preset=state.opening.demoPreset;
 if (!preset || preset==='manual') return '';
 const byClient=id=>state.offers.find(offer=>offer.clientId===id);
 const steps={
  match:[['Match eligible clients',state.clients.length>0],['Offer to Maya',!!byClient('maya')?.delivered],['Confirm Maya',byClient('maya')?.status==='accepted']],
  queue:[['Maya declines',byClient('maya')?.status==='declined'],['Alex times out',byClient('alex')?.status==='expired'],['Jordan confirms',byClient('jordan')?.status==='accepted']],
  saturday:[['Maya times out',byClient('maya')?.status==='expired'],['Offer to Alex',!!byClient('alex')?.delivered],['Reject late Maya',!!byClient('maya')?.late],['Confirm Alex',byClient('alex')?.status==='accepted']],
  exhausted:[['Maya declines',byClient('maya')?.status==='declined'],['Alex times out',byClient('alex')?.status==='expired'],['Jordan declines',byClient('jordan')?.status==='declined'],['Sam times out',byClient('sam')?.status==='expired']],
 }[preset];
 return `<section class="scenario-progress" aria-label="Scenario progress"><h2>${presets[preset]}</h2><ol>${steps.map(([label,done],index)=>`<li class="${done?'done':''}" ${!done&&steps.slice(0,index).every(step=>step[1])?'aria-current="step"':''}><span>${index+1}</span>${label}${done?'<span class="sr-only"> · Complete</span>':''}</li>`).join('')}</ol></section>`;
}
function staff(){
 const active=activeOffer();const accepted=state.offers.find(offer=>offer.status==='accepted');
 let offerInfo=active?`<span>Held for</span><strong>${getClient(active.clientId).name} <span class="countdown" data-countdown="${active.id}">${remaining(active)}</span></strong>`:accepted?`<span>Confirmed client</span><strong>${getClient(accepted.clientId).name}</strong>`:`<span>${({exhausted:'Queue complete',attention:'Needs attention',loading:'Matching',closed:'Closed'})[state.phase]??'Next in line'}</span><strong>${state.phase==='exhausted'?'0 clients remaining':state.phase==='attention'?'Check activity':state.phase==='loading'?'Reading waitlist':(clients.find(client=>client.eligible)?.name??'0 eligible clients')}</strong>`;
 const offerControls=active?`<button data-action="client" data-client="${active.clientId}">View SMS</button>`:state.phase==='open'&&!autoplay()?`<button class="primary" data-action="start">Start offers</button>`:'';
 return `<div class="page-head"><div class="heading-group"><h1>Waitlist</h1>${badge('Demo','sim')}</div></div>
 <div class="scenario-toolbar"><label for="scenario">Scenario</label><select id="scenario" title="Scenarios play simulated client replies through real Temporal workflows">${Object.entries(presets).map(([id,label])=>`<option value="${id}" ${selectedPreset===id?'selected':''}>${label}</option>`).join('')}</select><button class="primary" data-action="reset">${selectedPreset==='manual'?'New demo':'Run scenario'}</button>${state.opening.demoPreset&&state.opening.demoPreset!=='manual'?badge(state.demo?.status==='complete'?'Playback complete':state.demo?.status==='failed'?'Playback interrupted':'Auto playback',state.demo?.status==='failed'?'red':'sim'):''}</div>${scenarioProgress()}
 <div class="workspace"><div class="main-column"><section class="appointment" aria-label="Open appointment"><div class="appointment-top"><div><div class="appointment-date">${date(state.appointment)}</div><div class="appointment-title">${time(state.appointment)}</div></div>${phaseBadge()}</div><dl class="facts"><div><dt>Service</dt><dd>Haircut</dd></div><div><dt>Stylist</dt><dd>Jamie</dd></div><div><dt>Duration</dt><dd>45 min</dd></div><div><dt>Offer window</dt><dd>${state.phase==='open'&&!autoplay()?`<select id="timer" aria-label="Offer window"><option value="30000" ${windowMs===30000?'selected':''}>30 sec · demo</option><option value="900000" ${windowMs===900000?'selected':''}>15 min</option></select>`:state.opening.responseWindowMs===10000?'10 sec · demo':state.opening.responseWindowMs===30000?'30 sec · demo':'15 min'}</dd></div></dl><div class="offer-strip"><div class="hold">${offerInfo}</div><div class="actions">${offerControls}</div></div></section>
 <section aria-label="Waitlist priority"><div class="section-head"><h2>Eligible clients<span class="count">${clients.filter(c=>c.eligible).length}</span></h2>${badge('Earliest joined first')}</div><div class="table-wrap"><table><thead><tr><th scope="col">Order</th><th scope="col">Client</th><th scope="col">Joined</th><th scope="col">Offer</th></tr></thead><tbody>${clients.filter(c=>c.eligible).map((c,index)=>{const offer=state.offers.find(o=>o.clientId===c.id);const label=offer?({sending:'Sending',active:'Awaiting reply',accepting:'Booking',accepted:'Confirmed',declined:'Declined',expired:offer.late?'Late reply':'Expired',delivery_failed:'Delivery failed',booking_failed:'Needs attention'})[offer.status]:state.phase==='booked'?'Not contacted':'Queued';return `<tr class="${offer?.status==='active'?'active':''}"><td class="priority">${String(index+1).padStart(2,'0')}</td><td><div class="name-cell"><span class="avatar" aria-hidden="true">${c.initials}</span><button class="person-link" data-action="client" data-client="${c.id}" title="View ${c.name}'s inbox">${c.name}</button></div></td><td class="muted">${c.joined}</td><td>${badge(label,offer?.status==='active'?'amber':offer?.status==='accepted'?'green':'')}</td></tr>`;}).join('')}</tbody></table></div></section>
 <section style="margin-top:30px" aria-label="Clients not eligible"><div class="section-head"><h2>Not eligible<span class="count">${clients.filter(c=>!c.eligible).length}</span></h2></div><div class="table-wrap"><table><thead><tr><th scope="col">Client</th><th scope="col">Requested service</th><th scope="col">Stylist</th><th scope="col">Match</th></tr></thead><tbody>${clients.filter(c=>!c.eligible).map(c=>`<tr><td><button class="person-link" data-action="client" data-client="${c.id}">${c.name}</button></td><td>${c.service}</td><td>${c.stylist}</td><td class="muted">${c.reason}</td></tr>`).join('')}</tbody></table></div></section></div>
 <aside aria-label="Offer history"><div class="section-head"><h2>Activity</h2><a class="workflow-link" href="http://localhost:8233/namespaces/default/workflows/${state.workflowId}" target="_blank" rel="noopener" title="Inspect this opening in Temporal">Workflow history</a></div><ol class="history">${state.events.map(event=>`<li><strong>${event.text}</strong>${event.person?`<span class="event-person">${event.person}</span>`:''}<time>${clockTime(event.at)}</time></li>`).join('')}</ol></aside></div>`;
}
function clientView(){
 const client=getClient(currentView);const offers=state.offers.filter(offer=>offer.clientId===client.id&&offer.delivered);
 return `<div class="client-shell"><div class="page-head"><div class="client-head"><span class="avatar" aria-hidden="true">${client.initials}</span><h1>${client.name}</h1></div>${badge(autoplay()?'Auto playback':'Demo','sim')}</div><section class="inbox" aria-label="Client SMS inbox"><div class="inbox-header"><h2>Juniper Salon</h2>${badge(`SMS · ${offers.length}`)}</div><div class="messages">${offers.length?offers.map(offer=>`<article class="message"><div class="message-time">${date(offer.sentAt)} · ${time(offer.sentAt)}</div><div class="sms"><p>Hi ${client.name.split(' ')[0]}, an earlier haircut with Jamie is available. Would you like it?</p><dl class="offer-details"><div><dt>Appointment</dt><dd>${date(state.appointment)}</dd></div><div><dt>Time</dt><dd>${time(state.appointment)}</dd></div><div><dt>Duration</dt><dd>45 min</dd></div><div><dt>Reply by</dt><dd>${clockTime(offer.expiresAt)}</dd></div></dl>${offer.status==='active'?`<div class="offer-result"><span>Held for you</span><strong class="countdown" data-countdown="${offer.id}">${remaining(offer)}</strong></div><div class="message-actions"><button class="primary" data-action="accept" data-offer="${offer.id}">Accept appointment</button><button data-action="decline" data-offer="${offer.id}">Decline</button></div>`:`<div class="offer-result">${badge(({sending:'Sending',accepting:'Confirming appointment',accepted:'Appointment confirmed',declined:'Offer declined',expired:'Offer expired',delivery_failed:'Delivery failed',booking_failed:'Booking needs attention'})[offer.status],offer.status==='accepted'?'green':'')}${offer.status==='expired'?`<button class="quiet" data-action="late" data-offer="${offer.id}" ${offer.late?'disabled':''} title="Send a late reply to test rejection by the workflow">${offer.late?'Late reply recorded':'Try late acceptance'}</button>`:''}</div>`}</div>${offer.status==='accepted'?'<div class="reply">Yes, I’ll take it.</div>':offer.status==='declined'?'<div class="reply">No thanks, not this time.</div>':offer.late?'<div class="reply">Late acceptance rejected.</div>':''}</article>`).join(''):'<div class="empty-count">0 messages</div>'}</div></section><div class="client-status"><span class="muted">${client.service} · ${client.stylist}</span><button class="quiet" data-action="staff">Back to staff</button></div></div>`;
}
function render() {
  document.querySelector('#client-options').innerHTML = clients.map(client => {
    const active = state.offers.some(offer => offer.clientId === client.id && offer.status === 'active');
    return `<option value="${client.id}">${client.name}${active ? ' · New offer':''}</option>`;
  }).join('');
  view.value = currentView;
  app.innerHTML = currentView === 'staff' ? staff() : clientView();
  app.querySelectorAll('button[data-action="start"],button[data-action="reset"],button[data-offer],#timer,#scenario').forEach(button => button.disabled = busy || (button.dataset.action === 'reset' && autoplay()) || (!!button.dataset.offer && autoplay()) || (button.dataset.action === 'late' && state.offers.find(offer => offer.id === button.dataset.offer)?.late));
}
function switchView(next) { currentView = next; render(); }
view.addEventListener('change', () => switchView(view.value));
app.addEventListener('change', event => { if (event.target.id === 'timer') windowMs = Number(event.target.value); if (event.target.id === 'scenario') { selectedPreset=event.target.value; render(); } });
app.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'client') return switchView(button.dataset.client);
  if (action === 'staff') return switchView('staff');
  if (action === 'retry') return refresh();
  if (busy) return;
  busy = true; generation++; render();
  try {
    if (action === 'reset') {
      currentView = 'staff';
      applyState(await request('/api/demo/new', {preset:selectedPreset}));
      notify(selectedPreset==='manual'?'New demo opening created.':'Scenario started.');
    } else if (action === 'start') {
      applyState(await request(`/api/openings/${state.opening.id}/start`, { responseWindowMs:windowMs }));
    } else if (['accept','decline','late'].includes(action)) {
      const data = await request(`/api/openings/${state.opening.id}/reply`, { offerId:button.dataset.offer, clientId:currentView, response:action === 'decline' ? 'decline':'accept' });
      applyState(data.state);
      notify(({confirmed:'Appointment confirmed.',declined:'Offer declined.',expired:'This offer has expired. Your reply was recorded.',invalid_offer:'This offer does not belong to this client.',unavailable:'This offer is no longer available.',booking_failed:'Booking could not be confirmed. Staff attention is required.'})[data.result.code]);
    }
  } catch (error) { notify(error.message || 'Connection lost. Retry to check your result.'); }
  finally { busy = false; render(); }
});
setInterval(() => {
  if (!state) return;
  document.querySelectorAll('[data-countdown]').forEach(element => {
    const offer = state.offers.find(item => item.id === element.dataset.countdown);
    if (offer) element.textContent = remaining(offer);
  });
}, 250);
setInterval(refresh, 1000);
app.innerHTML = '<h1>Connecting…</h1>';
refresh();
