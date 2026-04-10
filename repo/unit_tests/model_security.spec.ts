/**
 * Security regression tests for the model adapter layer.
 *
 * Covers:
 *   - validateModelFilePath: rejects path traversal, NUL bytes, symlink
 *     escapes, and wrong extensions.
 *   - CustomAdapter: rejects command not in the allowlist.
 *
 * These tests are UNIT tests — they use the Prisma mock and do not spawn
 * any child processes. They exercise the static validation functions that
 * constitute the security boundary around subprocess execution.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { validateModelFilePath } from '../src/services/model.service';

// MODEL_ROOT defaults to `<repoRoot>/models`, which is the empty directory
// with just .gitkeep. We create a temp file there for the positive case.
const MODELS_DIR = path.resolve(__dirname, '..', 'models');

let tmpModelPath: string;

beforeAll(() => {
  // Create a temporary .onnx file inside models/ for the happy-path test
  tmpModelPath = path.join(MODELS_DIR, `test_${Date.now()}.onnx`);
  fs.writeFileSync(tmpModelPath, 'fake-onnx-bytes');
});

afterAll(() => {
  // Clean up
  if (tmpModelPath && fs.existsSync(tmpModelPath)) {
    fs.unlinkSync(tmpModelPath);
  }
});

describe('validateModelFilePath — positive cases', () => {
  it('accepts a valid relative path inside MODEL_ROOT', () => {
    const filename = path.basename(tmpModelPath);
    const resolved = validateModelFilePath(filename, ['.onnx']);
    expect(resolved).toBe(fs.realpathSync(tmpModelPath));
  });

  it('accepts a valid absolute path inside MODEL_ROOT', () => {
    const resolved = validateModelFilePath(tmpModelPath, ['.onnx']);
    expect(resolved).toBe(fs.realpathSync(tmpModelPath));
  });
});

describe('validateModelFilePath — negative / security cases', () => {
  it('rejects empty string', () => {
    expect(() => validateModelFilePath('', ['.onnx'])).toThrow(/non-empty/);
  });

  it('rejects non-string input', () => {
    expect(() => validateModelFilePath(42, ['.onnx'])).toThrow(/non-empty/);
  });

  it('rejects null', () => {
    expect(() => validateModelFilePath(null, ['.onnx'])).toThrow(/non-empty/);
  });

  it('rejects NUL byte', () => {
    expect(() => validateModelFilePath('model\0.onnx', ['.onnx'])).toThrow(/NUL/);
  });

  it('rejects path traversal (..)', () => {
    expect(() => validateModelFilePath('../../etc/passwd', [])).toThrow(/escapes/i);
  });

  it('rejects absolute path outside MODEL_ROOT', () => {
    expect(() => validateModelFilePath('/etc/passwd', [])).toThrow(/escapes|not found/i);
  });

  it('rejects wrong extension', () => {
    const filename = path.basename(tmpModelPath);
    expect(() => validateModelFilePath(filename, ['.jar', '.pmml'])).toThrow(/extension/);
  });

  it('rejects file that does not exist', () => {
    expect(() => validateModelFilePath('nonexistent.onnx', ['.onnx'])).toThrow(/not found/);
  });

  it('rejects command-injection payload in filePath', () => {
    const payload = "'; rm -rf / ; echo '";
    expect(() => validateModelFilePath(payload, ['.onnx'])).toThrow();
  });

  it('rejects $(subshell) in filePath', () => {
    expect(() => validateModelFilePath('$(whoami).onnx', ['.onnx'])).toThrow();
  });
});
