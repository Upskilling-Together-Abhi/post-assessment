# Juniper Salon

A waitlist demo powered by Temporal. Square, Google Sheets, and SMS are simulated.

When an appointment opens, eligible clients are contacted one at a time in waitlist order. A timely acceptance books the opening; a decline or timeout moves to the next client. Late replies cannot claim an expired offer.

## Run

Install **Node.js 20+** and start **Docker Desktop**. From this project folder:

```bash
npm ci && npm run dev
```

Keep the terminal open. The first run downloads the Temporal image.
The command starts Temporal, the Worker, and the web server. Ports `3000`, `7233`, and `8233` must be available.

## Try it

1. Open **[localhost:3000](http://localhost:3000)**.
2. Choose a scenario and click **Run scenario**.
3. Watch offers expire, advance, and book automatically.

Inspect workflows at **[localhost:8233](http://localhost:8233)**.

To reply yourself, choose **Manual walkthrough** → **New demo** → **Start offers**. Use **View as** to switch to a client and accept or decline. Automated scenarios use 10-second deadlines; manual mode offers 30 seconds or 15 minutes.

Temporal manages offer deadlines and recovery, even when the browser is closed. To try recovery, stop with **Ctrl-C**, then run `npm run dev` again. Keep `.data/` and the Docker volume to preserve the demo state.

## Stop

Press **Ctrl-C**, then run `npm run stop`. Demo data is preserved.

## Checks

```bash
npm run typecheck && npm test
```
