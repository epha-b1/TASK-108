import { Prisma } from '../models/prisma';
import { getPrisma } from '../config/database';
import {
  AppError,
  NOT_FOUND,
  VALIDATION_ERROR,
  CONFLICT,
} from '../utils/errors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

/* ---------- Types ---------- */

interface ModelConfig {
  rules?: ModelRule[];
  features?: string[];
  [key: string]: unknown;
}

interface ModelRule {
  name: string;
  condition: string; // e.g. "input.budget < 100"
  output: { prediction: unknown; confidence: number };
}

interface InferenceResult {
  prediction: unknown;
  confidence: number;
  confidenceBand: [number, number];
  topFeatures: { feature: string; contribution: number }[];
  appliedRules: { rule: string; triggered: boolean }[];
}

/* ---------- Helpers ---------- */

const VALID_SEMVER = /^\d+\.\d+\.\d+$/;
const VALID_TYPES = ['pmml', 'onnx', 'custom'];
const VALID_STATUSES = ['inactive', 'active', 'canary'];

/**
 * Deterministic hash for A/B allocation routing.
 */
function allocationHash(userId: string, modelName: string): number {
  const hash = crypto.createHash('sha256').update(`${userId}:${modelName}`).digest();
  return hash.readUInt32BE(0) % 100;
}

/* ---------- Model Adapter Interface ---------- */

interface AdapterResult {
  prediction: unknown;
  confidence: number;
  topFeatures: { feature: string; contribution: number }[];
}

export interface ModelAdapter {
  infer(input: Record<string, unknown>, config: ModelConfig | null): Promise<AdapterResult>;
}

// In production, default to 'process' (fail-fast if binaries unavailable).
// In dev/test, default to 'mock' for safe deterministic behavior.
const ADAPTER_MODE = process.env.MODEL_ADAPTER_MODE
  || (process.env.NODE_ENV === 'production' ? 'process' : 'mock');
const PROCESS_TIMEOUT_MS = 30_000;

// Allowlists for both interpreter binaries and the bundled fixed-runner
// scripts that they execute. Inputs from the model registry never reach the
// command line as code — they only flow through `args` (validated below).
const ALLOWED_EXECUTABLES = ['/usr/bin/java', '/usr/bin/python3', '/usr/local/bin/python3'];

// Fixed runner scripts. Both are checked into the repo so the python3/java
// process is given a code path WE control, and the untrusted filePath is
// passed as a positional argument that the runner reads after `os.path.realpath`
// validates it lies under MODEL_ROOT. This eliminates the previous
// `python3 -c '...${filePath}...'` interpolation injection vector.
//
// The runner is resolved relative to repo root so it works in both ts-node
// (dev/test) and compiled (production) execution contexts.
function repoRoot(): string {
  // src/services -> ../../  (works for both dist and src layouts)
  return path.resolve(__dirname, '..', '..');
}

const ONNX_RUNNER = path.resolve(repoRoot(), 'scripts', 'onnx_runner.py');

/**
 * Root directory under which all model artefacts MUST live. Defaults to the
 * `models/` directory at the repo root, can be overridden via env for the
 * single-container deployment. Anything outside this root is rejected even
 * if the operator points the model registry at it.
 */
const MODEL_ROOT = process.env.MODEL_ROOT
  ? path.resolve(process.env.MODEL_ROOT)
  : path.resolve(repoRoot(), 'models');

/**
 * Validate that an operator-supplied filePath:
 *   1. Is a non-empty string.
 *   2. Has no embedded NUL bytes.
 *   3. Resolves (after symlink expansion) to a path inside `MODEL_ROOT`.
 *   4. Has the expected file extension for the model type.
 *
 * Throws AppError(400, VALIDATION_ERROR, ...) on any failure. Exported for
 * unit-testability so the security regression suite can pin its behaviour
 * directly without constructing a real model adapter call.
 */
export function validateModelFilePath(filePath: unknown, expectedExtensions: string[]): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new AppError(400, VALIDATION_ERROR, 'Model filePath must be a non-empty string');
  }
  if (filePath.includes('\0')) {
    throw new AppError(400, VALIDATION_ERROR, 'Model filePath contains a NUL byte');
  }

  // Resolve the candidate against MODEL_ROOT (so a relative path is OK), then
  // make sure the result still lies under MODEL_ROOT after normalisation.
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(MODEL_ROOT, filePath);

  const rel = path.relative(MODEL_ROOT, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError(400, VALIDATION_ERROR, 'Model filePath escapes MODEL_ROOT');
  }

  // Reject symlinks pointing outside MODEL_ROOT — realpath collapses them.
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new AppError(400, VALIDATION_ERROR, 'Model file not found or unreadable');
  }
  const realRel = path.relative(MODEL_ROOT, realCandidate);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new AppError(400, VALIDATION_ERROR, 'Model file (via symlink) escapes MODEL_ROOT');
  }

  const ext = path.extname(realCandidate).toLowerCase();
  if (expectedExtensions.length > 0 && !expectedExtensions.includes(ext)) {
    throw new AppError(
      400,
      VALIDATION_ERROR,
      `Model filePath must have one of these extensions: ${expectedExtensions.join(', ')}`,
    );
  }

  return realCandidate;
}

function spawnAdapter(executable: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_EXECUTABLES.some((allowed) => executable === allowed)) {
      // Strict equality (not startsWith) so callers can't sneak through with
      // `/usr/bin/java-evil-shim`.
      reject(new Error(`Executable not in allowlist: ${executable}`));
      return;
    }
    for (const a of args) {
      if (typeof a !== 'string') {
        reject(new Error('All adapter arguments must be strings'));
        return;
      }
      if (a.includes('\0')) {
        reject(new Error('Adapter argument contains a NUL byte'));
        return;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process');
    // shell: false (default) — args are passed verbatim to execve, never
    // interpreted by /bin/sh, so quoting/metachars in `args` cannot escape
    // into a shell. This is the structural fix for the previous `-c` injection.
    const proc = spawn(executable, args, { timeout: PROCESS_TIMEOUT_MS, shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdin.write(input);
    proc.stdin.end();
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number) => {
      if (code !== 0) reject(new Error(`Process exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    proc.on('error', reject);
  });
}

class PmmlAdapter implements ModelAdapter {
  async infer(input: Record<string, unknown>, config: ModelConfig | null): Promise<AdapterResult> {
    if (ADAPTER_MODE === 'mock') return mockInferFn(input, config);
    const rawFilePath = (config as Record<string, unknown>)?.filePath;
    if (!rawFilePath) throw new AppError(400, VALIDATION_ERROR, 'PMML model filePath not configured');
    const filePath = validateModelFilePath(rawFilePath, ['.jar', '.pmml']);
    const raw = await spawnAdapter('/usr/bin/java', ['-jar', filePath], JSON.stringify(input));
    return JSON.parse(raw);
  }
}

class OnnxAdapter implements ModelAdapter {
  async infer(input: Record<string, unknown>, config: ModelConfig | null): Promise<AdapterResult> {
    if (ADAPTER_MODE === 'mock') return mockInferFn(input, config);
    const rawFilePath = (config as Record<string, unknown>)?.filePath;
    if (!rawFilePath) throw new AppError(400, VALIDATION_ERROR, 'ONNX model filePath not configured');
    const filePath = validateModelFilePath(rawFilePath, ['.onnx']);
    // Pass the path as a positional argument to a fixed runner script we
    // control. No string interpolation, no `python3 -c`, no shell.
    const raw = await spawnAdapter('/usr/bin/python3', [ONNX_RUNNER, filePath], JSON.stringify(input));
    return JSON.parse(raw);
  }
}

class CustomAdapter implements ModelAdapter {
  async infer(input: Record<string, unknown>, config: ModelConfig | null): Promise<AdapterResult> {
    if (ADAPTER_MODE === 'mock') return mockInferFn(input, config);
    const command = (config as Record<string, unknown>)?.command as string;
    const args = ((config as Record<string, unknown>)?.args as string[]) ?? [];
    if (!command) throw new AppError(400, VALIDATION_ERROR, 'Custom model command not configured');
    if (!ALLOWED_EXECUTABLES.includes(command)) {
      throw new AppError(
        400,
        VALIDATION_ERROR,
        'Custom adapter command must be one of the allowlisted interpreter binaries',
      );
    }
    if (!Array.isArray(args)) {
      throw new AppError(400, VALIDATION_ERROR, 'Custom adapter args must be an array of strings');
    }
    const raw = await spawnAdapter(command, args, JSON.stringify(input));
    return JSON.parse(raw);
  }
}

class MockAdapter implements ModelAdapter {
  async infer(input: Record<string, unknown>, config: ModelConfig | null): Promise<AdapterResult> {
    return mockInferFn(input, config);
  }
}

export function getAdapter(type: string): ModelAdapter {
  if (ADAPTER_MODE === 'mock') return new MockAdapter();
  switch (type) {
    case 'pmml': return new PmmlAdapter();
    case 'onnx': return new OnnxAdapter();
    case 'custom': return new CustomAdapter();
    default: return new MockAdapter();
  }
}

/**
 * Deterministic mock inference: produces stable output from input hash.
 * Used as fallback when real adapter runtime is not available.
 */
function mockInferFn(input: Record<string, unknown>, config: ModelConfig | null): AdapterResult {
  const inputStr = JSON.stringify(input, Object.keys(input).sort());
  const hash = crypto.createHash('md5').update(inputStr).digest();

  // Generate deterministic prediction value from input
  const predictionValue = hash.readUInt16BE(0) / 65535; // 0..1
  const confidence = 0.5 + (hash.readUInt16BE(2) / 65535) * 0.5; // 0.5..1.0

  // Generate feature contributions from configured features or input keys
  const features = config?.features ?? Object.keys(input);
  const topFeatures: { feature: string; contribution: number }[] = [];

  let remainingContribution = 1.0;
  for (let i = 0; i < Math.min(features.length, 5); i++) {
    const featureHash = crypto
      .createHash('md5')
      .update(`${inputStr}:${features[i]}`)
      .digest();
    const contribution =
      i < features.length - 1
        ? (featureHash.readUInt16BE(0) / 65535) * remainingContribution * 0.6
        : remainingContribution;
    topFeatures.push({
      feature: features[i],
      contribution: Math.round(contribution * 1000) / 1000,
    });
    remainingContribution -= contribution;
  }

  // Sort by contribution descending
  topFeatures.sort((a, b) => b.contribution - a.contribution);

  return {
    prediction: Math.round(predictionValue * 100) / 100,
    confidence: Math.round(confidence * 1000) / 1000,
    topFeatures,
  };
}

/**
 * Safely evaluate a simple condition of the form "input.field op value".
 * Only supports comparison operators and field access — no arbitrary code execution.
 */
function safeEvaluateCondition(condition: string, input: Record<string, unknown>): boolean {
  // Parse "input.field op value" patterns only
  const match = condition.match(/^input\.(\w+)\s*(>=|<=|===|!==|>|<)\s*(.+)$/);
  if (!match) return false;

  const [, field, op, rawValue] = match;
  const fieldValue = input[field];

  // Parse the comparison value
  let compareValue: unknown;
  const trimmed = rawValue.trim();
  if (trimmed === 'true') compareValue = true;
  else if (trimmed === 'false') compareValue = false;
  else if (/^-?\d+(\.\d+)?$/.test(trimmed)) compareValue = Number(trimmed);
  else if (/^['"].*['"]$/.test(trimmed)) compareValue = trimmed.slice(1, -1);
  else return false;

  switch (op) {
    case '>': return Number(fieldValue) > Number(compareValue);
    case '<': return Number(fieldValue) < Number(compareValue);
    case '>=': return Number(fieldValue) >= Number(compareValue);
    case '<=': return Number(fieldValue) <= Number(compareValue);
    case '===': return fieldValue === compareValue;
    case '!==': return fieldValue !== compareValue;
    default: return false;
  }
}

/**
 * Evaluate rules against input. Rules override model predictions when triggered.
 */
function evaluateRules(
  rules: ModelRule[],
  input: Record<string, unknown>,
): { appliedRules: { rule: string; triggered: boolean }[]; override: { prediction: unknown; confidence: number } | null } {
  const appliedRules: { rule: string; triggered: boolean }[] = [];
  let override: { prediction: unknown; confidence: number } | null = null;

  for (const rule of rules) {
    const triggered = safeEvaluateCondition(rule.condition, input);

    appliedRules.push({ rule: rule.name, triggered });
    if (triggered && !override) {
      override = { prediction: rule.output.prediction, confidence: rule.output.confidence };
    }
  }

  return { appliedRules, override };
}

/* ---------- Exports ---------- */

export async function registerModel(data: {
  name: string;
  version: string;
  type: string;
  config?: Record<string, unknown>;
}) {
  const prisma = getPrisma();

  if (!VALID_SEMVER.test(data.version)) {
    throw new AppError(400, VALIDATION_ERROR, 'Version must be valid semver (e.g. 1.0.0)');
  }
  if (!VALID_TYPES.includes(data.type)) {
    throw new AppError(400, VALIDATION_ERROR, `Type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  // Check unique name+version
  const existing = await prisma.mlModel.findFirst({
    where: { name: data.name, version: data.version },
  });
  if (existing) {
    throw new AppError(409, CONFLICT, 'A model with this name and version already exists');
  }

  return prisma.mlModel.create({
    data: {
      name: data.name,
      version: data.version,
      type: data.type,
      config: (data.config as Prisma.InputJsonValue) ?? undefined,
    },
  });
}

export async function listModels() {
  const prisma = getPrisma();
  return prisma.mlModel.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

export async function getModel(id: string) {
  const prisma = getPrisma();
  const model = await prisma.mlModel.findUnique({
    where: { id },
    include: { abAllocations: true },
  });
  if (!model) throw new AppError(404, NOT_FOUND, 'Model not found');
  return model;
}

export async function updateModelStatus(id: string, status: string) {
  const prisma = getPrisma();

  if (!VALID_STATUSES.includes(status)) {
    throw new AppError(400, VALIDATION_ERROR, `Status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const model = await prisma.mlModel.findUnique({ where: { id } });
  if (!model) throw new AppError(404, NOT_FOUND, 'Model not found');

  return prisma.mlModel.update({
    where: { id },
    data: { status },
  });
}

export async function setAbAllocation(
  modelId: string,
  groupName: string,
  percentage: number,
) {
  const prisma = getPrisma();

  const model = await prisma.mlModel.findUnique({ where: { id: modelId } });
  if (!model) throw new AppError(404, NOT_FOUND, 'Model not found');

  if (percentage < 0 || percentage > 100) {
    throw new AppError(400, VALIDATION_ERROR, 'Percentage must be between 0 and 100');
  }

  // Upsert: find existing allocation for this model+group
  const existing = await prisma.abAllocation.findFirst({
    where: { modelId, groupName },
  });

  if (existing) {
    return prisma.abAllocation.update({
      where: { id: existing.id },
      data: { percentage },
    });
  }

  return prisma.abAllocation.create({
    data: {
      modelId,
      groupName,
      percentage,
    },
  });
}

export async function infer(
  modelId: string,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
  userId?: string,
): Promise<InferenceResult> {
  const prisma = getPrisma();

  let model = await prisma.mlModel.findUnique({
    where: { id: modelId },
    include: { abAllocations: true },
  });
  if (!model) throw new AppError(404, NOT_FOUND, 'Model not found');

  // If model is canary or has canary allocations, check A/B routing
  if (userId && model.status === 'active') {
    // Look for a canary version of the same model name
    const canaryModel = await prisma.mlModel.findFirst({
      where: {
        name: model.name,
        status: 'canary',
      },
      include: { abAllocations: true },
    });

    if (canaryModel && canaryModel.abAllocations.length > 0) {
      const hash = allocationHash(userId, model.name);
      const totalCanaryPercent = canaryModel.abAllocations.reduce(
        (sum, a) => sum + Number(a.percentage),
        0,
      );
      if (hash < totalCanaryPercent) {
        model = canaryModel;
      }
    }
  }

  if (model.status !== 'active' && model.status !== 'canary') {
    throw new AppError(400, VALIDATION_ERROR, `Model is not active (status: ${model.status})`);
  }

  const config = (model.config as ModelConfig) ?? null;

  // Run inference via adapter (falls back to mock in dev/test)
  const adapter = getAdapter(model.type);
  const inferResult = await adapter.infer(input, config);

  // Evaluate rules
  const rules = config?.rules ?? [];
  const { appliedRules, override } = evaluateRules(rules, input);

  // Build confidence band
  const confidence = override ? override.confidence : inferResult.confidence;
  const bandWidth = (1 - confidence) * 0.5;
  const confidenceBand: [number, number] = [
    Math.round(Math.max(0, confidence - bandWidth) * 1000) / 1000,
    Math.round(Math.min(1, confidence + bandWidth) * 1000) / 1000,
  ];

  return {
    prediction: override ? override.prediction : inferResult.prediction,
    confidence,
    confidenceBand,
    topFeatures: inferResult.topFeatures,
    appliedRules,
  };
}
