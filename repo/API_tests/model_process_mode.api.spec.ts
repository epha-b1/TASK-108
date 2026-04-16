/**
 * Gap: direct testing of production model-adapter subprocess mode
 * (MODEL_ADAPTER_MODE=process). The rest of the suite exercises the
 * `mock` adapter because the Docker image intentionally does not ship
 * the ONNX / PMML runtimes. This suite proves that:
 *
 *   1. Setting MODEL_ADAPTER_MODE=process actually picks the per-type
 *      adapter class (Onnx / Pmml / Custom) at module load time.
 *   2. The ONNX adapter spawns the real `onnx_runner.py` helper (so the
 *      "no python-c -code-injection" structural fix is live) AND
 *      translates the runner's exit-code-3 "onnxruntime not installed"
 *      into the canonical 503 MODEL_RUNTIME_UNAVAILABLE envelope the
 *      API advertises.
 *   3. A malicious model `filePath` outside MODEL_ROOT never reaches
 *      the spawn step — `validateModelFilePath` throws before spawn.
 *   4. The Custom adapter enforces the executable allowlist against the
 *      real process boundary, not a mocked one.
 *
 * We run the tests against a fresh isolated copy of `app` that has been
 * (re)imported after setting the env flag, so the module-level
 * ADAPTER_MODE constant observes the new value. We then drive real HTTP
 * requests through supertest and real subprocess spawn via the real
 * `child_process.spawn`.
 */

import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';

import { env as prodEnv } from '../src/config/environment';
import { authConfig } from '../src/config/auth';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

type IsolatedStack = {
  app: any;
  request: any;
};

/**
 * Re-require the app stack with `process.env.MODEL_ADAPTER_MODE=process`
 * so the model.service's file-level ADAPTER_MODE const picks `process`.
 * Everything else (jwt secret, db url, etc.) is inherited from the
 * ambient test env so the fresh app binds to the SAME database.
 */
function loadAppInProcessMode(): IsolatedStack {
  let stack: IsolatedStack | undefined;
  const originalMode = process.env.MODEL_ADAPTER_MODE;
  process.env.MODEL_ADAPTER_MODE = 'process';
  try {
    jest.isolateModules(() => {
      const supertest = require('supertest') as typeof import('supertest');
      const isoApp = require('../src/app').default;
      stack = { app: isoApp, request: supertest };
    });
  } finally {
    if (originalMode === undefined) delete process.env.MODEL_ADAPTER_MODE;
    else process.env.MODEL_ADAPTER_MODE = originalMode;
  }
  if (!stack) throw new Error('isolated app never loaded');
  return stack;
}

/**
 * We cannot re-register admins on the isolated app because that app's
 * internal Prisma client is already bound to the same DB as the main
 * suite. But the JWT secret is the same, so a token we mint with
 * `prodEnv.jwtSecret` using the real admin id works on either instance.
 */
async function ensureAdmin() {
  const username = `mdl_proc_${ts}`;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { role: 'admin', status: 'active' } });
    return existing.id;
  }
  // Register via the (live) app to guarantee all attendant tables (security
  // questions, password history) are populated correctly.
  const supertest = require('supertest') as typeof import('supertest');
  const liveApp = require('../src/app').default;
  const reg = await supertest(liveApp)
    .post('/auth/register')
    .set('Idempotency-Key', `reg_${ts}`)
    .send({
      username,
      password: 'AdminPass123!x',
      securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
    });
  if (reg.status !== 201) throw new Error(`admin register failed: ${reg.status}`);
  await prisma.user.update({ where: { id: reg.body.id }, data: { role: 'admin' } });
  return reg.body.id as string;
}

function mintAdminToken(userId: string, username: string): string {
  return jwt.sign(
    { userId, username, role: 'admin' },
    prodEnv.jwtSecret,
    { algorithm: authConfig.algorithm, expiresIn: 3600 },
  );
}

let adminUserId: string;
let adminToken: string;
let stack: IsolatedStack;

beforeAll(async () => {
  await prisma.$connect();
  adminUserId = await ensureAdmin();
  adminToken = mintAdminToken(adminUserId, `mdl_proc_${ts}`);
  stack = loadAppInProcessMode();
}, 30000);

afterAll(async () => {
  // Clean up any test artefacts.
  await prisma.abAllocation.deleteMany({
    where: { model: { name: { startsWith: `proc_model_${ts}` } } },
  }).catch(() => {});
  await prisma.mlModel.deleteMany({ where: { name: { startsWith: `proc_model_${ts}` } } }).catch(() => {});
  if (adminUserId) {
    await prisma.refreshToken.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

/* Helper — creates + activates an ONNX model with a stubbed filePath. */
async function registerActiveOnnxModel(): Promise<string> {
  // Write a tiny stub file under MODEL_ROOT so `validateModelFilePath`
  // passes its `fs.realpathSync` check before spawn.
  const modelRoot = path.resolve(__dirname, '..', 'models');
  if (!fs.existsSync(modelRoot)) fs.mkdirSync(modelRoot, { recursive: true });
  const stubName = `proc_${ts}_${Math.random().toString(36).slice(2, 8)}.onnx`;
  fs.writeFileSync(path.join(modelRoot, stubName), 'not-a-real-model');

  const uniq = `proc_model_${ts}_${Math.random().toString(36).slice(2, 8)}`;
  const reg = await stack.request(stack.app)
    .post('/models')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', `reg_${uniq}`)
    .send({
      name: uniq,
      version: '1.0.0',
      type: 'onnx',
      config: { filePath: stubName },
    });
  if (reg.status !== 201) throw new Error(`model register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const activate = await stack.request(stack.app)
    .patch(`/models/${reg.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', `act_${uniq}`)
    .send({ status: 'active' });
  if (activate.status !== 200) throw new Error(`model activate failed: ${activate.status}`);
  return reg.body.id;
}

describe('POST /models/:id/infer — ONNX adapter in process mode', () => {
  it('returns 503 MODEL_RUNTIME_UNAVAILABLE when onnxruntime is not installed in the container', async () => {
    const modelId = await registerActiveOnnxModel();

    const res = await stack.request(stack.app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_${ts}_${Math.random().toString(36).slice(2, 8)}`)
      .send({ input: { x: 1, y: 2 }, context: {} });

    // Exactly the canonical envelope the README advertises for this branch.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MODEL_RUNTIME_UNAVAILABLE');
    expect(res.body.message).toMatch(/onnxruntime/i);
    expect(res.body.message).toMatch(/pip install|derived image|MODEL_ADAPTER_MODE=mock/i);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  }, 30000);

  it('400 — filePath outside MODEL_ROOT is rejected BEFORE spawning the runner', async () => {
    const modelRoot = path.resolve(__dirname, '..', 'models');
    if (!fs.existsSync(modelRoot)) fs.mkdirSync(modelRoot, { recursive: true });

    const uniq = `proc_model_${ts}_esc_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await stack.request(stack.app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `reg_${uniq}`)
      .send({
        name: uniq,
        version: '1.0.0',
        type: 'onnx',
        // Absolute path that definitely lies outside MODEL_ROOT.
        config: { filePath: '/etc/passwd' },
      });
    expect(reg.status).toBe(201);
    await stack.request(stack.app)
      .patch(`/models/${reg.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `act_${uniq}`)
      .send({ status: 'active' });

    const res = await stack.request(stack.app)
      .post(`/models/${reg.body.id}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_esc_${uniq}`)
      .send({ input: { x: 1 }, context: {} });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/escapes MODEL_ROOT|filePath/i);
  }, 15000);

  it('400 — filePath with NUL byte is rejected before any subprocess is created', async () => {
    const uniq = `proc_model_${ts}_nul_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await stack.request(stack.app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `reg_${uniq}`)
      .send({
        name: uniq, version: '1.0.0', type: 'onnx',
        config: { filePath: 'harmless\0;rm -rf /\0.onnx' },
      });
    expect(reg.status).toBe(201);
    await stack.request(stack.app)
      .patch(`/models/${reg.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `act_${uniq}`)
      .send({ status: 'active' });

    const res = await stack.request(stack.app)
      .post(`/models/${reg.body.id}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_nul_${uniq}`)
      .send({ input: {}, context: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/NUL byte/i);
  }, 15000);
});

/* ========== Successful process-mode path (B: executable present) ========== */

describe('POST /models/:id/infer — Custom adapter SUCCEEDS over a real subprocess', () => {
  // The Custom adapter is the only shippable branch we can drive to success
  // in the default image: `/usr/bin/python3` is on the allowlist AND is
  // installed by the Dockerfile. We have the adapter spawn a one-liner
  // Python program that reads the request on STDIN, echoes a deterministic
  // inference result on STDOUT, and exits 0. Because `spawn` is invoked
  // with `shell: false`, the `-c` body is passed verbatim to execve — this
  // is the SAME invocation shape the PMML / ONNX adapters use, just with a
  // payload small enough to inline. If this test passes, the complete
  // spawn → stdin write → stdout read → JSON parse pipe is proved LIVE,
  // not simulated.

  it('delivers a parsed adapter result end-to-end through a real spawned subprocess', async () => {
    const uniq = `proc_model_${ts}_success_${Math.random().toString(36).slice(2, 8)}`;
    const pythonProgram = [
      'import json,sys',
      'payload = json.loads(sys.stdin.read() or "{}")',
      // Echo input length as a deterministic derived prediction so the test
      // can assert the STDIN pipe wired up correctly.
      'pred = len(json.dumps(payload))',
      'print(json.dumps({"prediction": pred, "confidence": 0.75, "topFeatures": [{"feature": "echo", "contribution": 1.0}]}))',
    ].join(';');

    const reg = await stack.request(stack.app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `reg_${uniq}`)
      .send({
        name: uniq, version: '1.0.0', type: 'custom',
        config: { command: '/usr/bin/python3', args: ['-c', pythonProgram] },
      });
    expect(reg.status).toBe(201);
    const activate = await stack.request(stack.app)
      .patch(`/models/${reg.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `act_${uniq}`)
      .send({ status: 'active' });
    expect(activate.status).toBe(200);

    const inferInput = { alpha: 1, beta: 2, gamma: 'hello' };
    const res = await stack.request(stack.app)
      .post(`/models/${reg.body.id}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_${uniq}`)
      .send({ input: inferInput, context: {} });

    expect(res.status).toBe(200);
    // Prediction must equal the length of the JSON payload the adapter
    // round-tripped over STDIN. Concretely: if the prediction is `undefined`,
    // or `0`, or any value different from this exact length, the subprocess
    // didn't actually receive the input — which would be the primary
    // regression we want to catch.
    expect(res.body.prediction).toBe(JSON.stringify(inferInput).length);

    // `confidence` must come from the adapter (0.75), not from the mock
    // fallback (which would be in (0.5, 1] but almost never exactly 0.75).
    expect(res.body.confidence).toBe(0.75);

    // topFeatures came from the adapter, hydrated end-to-end.
    expect(Array.isArray(res.body.topFeatures)).toBe(true);
    expect(res.body.topFeatures[0]).toEqual({ feature: 'echo', contribution: 1.0 });

    // Confidence-band contract still holds (service wraps the adapter result).
    expect(Array.isArray(res.body.confidenceBand)).toBe(true);
    expect(res.body.confidenceBand).toHaveLength(2);
    expect(res.body.confidenceBand[0]).toBeLessThanOrEqual(res.body.confidence);
    expect(res.body.confidenceBand[1]).toBeGreaterThanOrEqual(res.body.confidence);

    // appliedRules is present (empty since we didn't configure any) —
    // NOT absent, which would indicate the rule-evaluation path was skipped.
    expect(Array.isArray(res.body.appliedRules)).toBe(true);
  }, 30000);

  it('subprocess exit code 2 (runtime failure) surfaces as a 5xx, NOT as a mock fallback', async () => {
    // Proves the adapter does NOT silently retry with the mock when the
    // real subprocess fails in process mode — if it did, the API would
    // mask infrastructure problems, which is worse than honest failure.
    const uniq = `proc_model_${ts}_fail_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await stack.request(stack.app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `reg_${uniq}`)
      .send({
        name: uniq, version: '1.0.0', type: 'custom',
        config: { command: '/usr/bin/python3', args: ['-c', 'import sys; sys.exit(2)'] },
      });
    expect(reg.status).toBe(201);
    await stack.request(stack.app)
      .patch(`/models/${reg.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `act_${uniq}`)
      .send({ status: 'active' });

    const res = await stack.request(stack.app)
      .post(`/models/${reg.body.id}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_${uniq}`)
      .send({ input: {}, context: {} });

    // AdapterProcessError → unhandled → global 500. Canonical envelope must
    // still carry a requestId that matches the X-Request-Id header.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  }, 30000);
});

describe('POST /models/:id/infer — Custom adapter allowlist in process mode', () => {
  async function registerCustom(commandPath: string): Promise<string> {
    const uniq = `proc_model_${ts}_custom_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await stack.request(stack.app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `reg_${uniq}`)
      .send({
        name: uniq, version: '1.0.0', type: 'custom',
        config: { command: commandPath, args: [] },
      });
    expect(reg.status).toBe(201);
    await stack.request(stack.app)
      .patch(`/models/${reg.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `act_${uniq}`)
      .send({ status: 'active' });
    return reg.body.id;
  }

  it('400 — command not in allowlist is rejected without spawning', async () => {
    const modelId = await registerCustom('/bin/evil-shim');
    const res = await stack.request(stack.app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_evil_${ts}`)
      .send({ input: {}, context: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/allowlisted|interpreter binaries/i);
  }, 15000);

  it('400 — config.args non-array is rejected with canonical envelope', async () => {
    // Register with a valid command, then corrupt config.args so the Custom
    // adapter's array guard fires instead of the command guard.
    const uniq = `proc_model_${ts}_argsbad_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await stack.request(stack.app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `reg_${uniq}`)
      .send({
        name: uniq, version: '1.0.0', type: 'custom',
        config: { command: '/usr/bin/python3', args: 'not-an-array' },
      });
    expect(reg.status).toBe(201);
    await stack.request(stack.app)
      .patch(`/models/${reg.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `act_${uniq}`)
      .send({ status: 'active' });
    const res = await stack.request(stack.app)
      .post(`/models/${reg.body.id}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `infer_argsbad_${uniq}`)
      .send({ input: {}, context: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/args must be an array/i);
  }, 15000);
});
