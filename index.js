const express = require('express');
const { config } = require('./config');
const webhookRoute = require('./webhookRoute');
const newsletterRoute = require('./newsletterRoute');
const hermesRoute = require('./hermesRoute');
const leucrocottaRoute = require('./leucrocottaRoute');

const app = express();
// Render terminates TLS and sits behind a proxy: trust the first hop so
// req.ip/req.protocol are real (https), not the internal http hop.
app.set('trust proxy', 1);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// ponytail: `commit` answers "did my fix actually deploy?" without probing behavior.
// Render sets RENDER_GIT_COMMIT; locally there's no deploy, so say so.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', commit: process.env.RENDER_GIT_COMMIT || 'local' });
});

app.use('/webhooks', webhookRoute);
app.use('/newsletter', newsletterRoute);
app.use('/hermes', hermesRoute);
app.use('/leucrocotta', leucrocottaRoute);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Mayor email backend listening on port ${config.port}`);
});
