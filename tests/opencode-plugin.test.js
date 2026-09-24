#!/usr/bin/env node
// Contract tests for the OpenCode V1/V2 adapter. No model or live server is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-opencode-'));
process.env.XDG_CONFIG_HOME = tmp;
delete process.env.PONYTAIL_DEFAULT_MODE;

const root = path.join(__dirname, '..');
const statePath = path.join(tmp, 'opencode', '.ponytail-active');

let plugin;
let parseFrontmatterFile;

test.before(async () => {
  const url = pathToFileURL(path.join(root, '.opencode', 'plugins', 'ponytail.mjs'));
  plugin = (await import(url)).default;
  parseFrontmatterFile = require(path.join(root, '.opencode', 'plugins', 'ponytail-frontmatter.cjs'))
    .parseFrontmatterFile;
});

function resetMode(mode) {
  fs.rmSync(statePath, { force: true });
  if (mode) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, mode);
  }
}

function v1Prompt(command, args = '') {
  return { command, arguments: args, sessionID: 'session' };
}

async function setupV2() {
  const commands = new Map();
  const skills = new Map();
  const hooks = new Map();
  const prompts = [];
  const registration = { dispose: async () => {} };
  const ctx = {
    command: {
      transform: async (edit) => {
        edit({ add: (definition) => commands.set(definition.name, definition) });
        return registration;
      },
    },
    skill: {
      transform: async (edit) => {
        edit({ add: (skill) => skills.set(skill.id, skill) });
        return registration;
      },
    },
    session: {
      hook: async (name, hook) => {
        hooks.set(name, hook);
        return registration;
      },
      prompt: async (input) => {
        prompts.push(input);
        return { id: 'message', sessionID: input.sessionID, type: 'user' };
      },
    },
  };

  await plugin.setup(ctx);
  return { commands, skills, hooks, prompts };
}

function contextEvent(system = []) {
  return {
    sessionID: 'session',
    agent: 'build',
    model: { providerID: 'test', id: 'model' },
    system,
    messages: [],
    options: {},
    tools: {},
  };
}

test('checkout config declares the cross-version package only once', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
  assert.deepEqual(config.plugin, ['.']);
  assert.equal(fs.statSync(path.join(root, config.plugin[0])).isDirectory(), true);
  assert.equal(config.plugins, undefined);
});

test('package metadata declares the supported OpenCode range', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines.opencode, '>=1.18.29 <2 || >=2.0.15 <3');
});

test('one default export exposes the V2 definition and V1 server entrypoint', () => {
  assert.equal(plugin.id, 'ponytail');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(typeof plugin.server, 'function');
});

test('V1 registers commands and skills', async () => {
  const hooks = await plugin.server({});
  const config = {};
  await hooks.config(config);

  assert.equal(config.command.ponytail.description, 'Switch ponytail intensity level (lite/full/ultra/off)');
  assert.equal(config.skills.paths.length, 1);
  assert.match(config.skills.paths[0], /skills$/);
});

test('V1 injects the default level and preserves Qwen system merging', async () => {
  resetMode();
  const hooks = await plugin.server({});
  const output = { system: ['You are a helpful assistant.'] };
  await hooks['experimental.chat.system.transform']({ model: {} }, output);

  assert.equal(output.system.length, 1);
  assert.match(output.system[0], /You are a helpful assistant/);
  assert.match(output.system[0], /PONYTAIL MODE ACTIVE — level: full/);
});

test('V1 level commands persist, bare reports, and invalid input explains', async () => {
  const hooks = await plugin.server({});

  const switched = { parts: [] };
  await hooks['command.execute.before'](v1Prompt('ponytail', 'ultra'), switched);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'ultra');
  assert.match(switched.parts[0].text, /switched.*ultra/i);

  resetMode('lite');
  const bare = { parts: [{ type: 'text', text: 'generic template' }] };
  await hooks['command.execute.before'](v1Prompt('ponytail'), bare);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'lite');
  assert.match(bare.parts[0].text, /current.*lite/i);

  const invalid = { parts: [{ type: 'text', text: 'generic template' }] };
  await hooks['command.execute.before'](v1Prompt('ponytail', 'review'), invalid);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'lite');
  assert.match(invalid.parts[0].text, /off.*lite.*full.*ultra/i);
});

test('V1 off persists and unrelated commands do not touch state', async () => {
  const hooks = await plugin.server({});
  resetMode();

  await hooks['command.execute.before'](v1Prompt('commit', 'ultra'), { parts: [] });
  assert.equal(fs.existsSync(statePath), false);

  await hooks['command.execute.before'](v1Prompt('ponytail', 'off'), { parts: [] });
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'off');
  const output = { system: [] };
  await hooks['experimental.chat.system.transform']({ model: {} }, output);
  assert.deepEqual(output.system, []);
});

test('V2 registers all commands and skills', async () => {
  const { commands, skills } = await setupV2();

  assert.deepEqual([...commands.keys()].sort(), [
    'ponytail',
    'ponytail-audit',
    'ponytail-debt',
    'ponytail-gain',
    'ponytail-help',
    'ponytail-review',
  ]);
  assert.deepEqual([...skills.keys()].sort(), [...commands.keys()].sort());
  assert.match(skills.get('ponytail').path, /skills\/ponytail\/SKILL\.md$/);
  assert.match(skills.get('ponytail').description, /Forces the laziest solution/);
  assert.match(skills.get('ponytail').content, /^# Ponytail/);
});

test('V2 injects only into the agent-loop context', async () => {
  resetMode();
  const { hooks } = await setupV2();
  assert.deepEqual([...hooks.keys()], ['context']);

  const event = contextEvent([{ type: 'text', text: 'base system' }]);
  await hooks.get('context')(event);
  assert.equal(event.system.length, 2);
  assert.deepEqual(event.system[0], { type: 'text', text: 'base system' });
  assert.match(event.system[1].text, /PONYTAIL MODE ACTIVE — level: full/);

  resetMode('off');
  const off = contextEvent();
  await hooks.get('context')(off);
  assert.deepEqual(off.system, []);
});

test('V2 level commands share state and report invalid input', async () => {
  resetMode();
  const { commands, prompts } = await setupV2();
  const execute = (text, delivery = 'steer') =>
    commands.get('ponytail').execute({
      sessionID: 'session',
      prompt: { text },
      delivery,
    });

  await execute('ultra', 'queue');
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'ultra');
  assert.equal(prompts.at(-1).delivery, 'queue');
  assert.match(prompts.at(-1).text, /switched.*ultra/i);

  await execute('');
  assert.match(prompts.at(-1).text, /current.*ultra/i);

  await execute('review');
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'ultra');
  assert.match(prompts.at(-1).text, /off.*lite.*full.*ultra/i);
});

test('V2 command templates preserve arguments and delivery', async () => {
  const { commands, prompts } = await setupV2();
  await commands.get('ponytail-review').execute({
    sessionID: 'session',
    prompt: { text: 'staged files' },
    delivery: 'queue',
  });

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionID, 'session');
  assert.equal(prompts[0].delivery, 'queue');
  assert.match(prompts[0].text, /Review the current code changes/);
  assert.match(prompts[0].text, /Arguments: staged files/);
});

test('V1 and V2 share the active level file', async () => {
  resetMode();
  const legacy = await plugin.server({});
  await legacy['command.execute.before'](v1Prompt('ponytail', 'ultra'), { parts: [] });

  const { commands, hooks } = await setupV2();
  const fromV2 = contextEvent();
  await hooks.get('context')(fromV2);
  assert.match(fromV2.system[0].text, /level: ultra/);

  await commands.get('ponytail').execute({
    sessionID: 'session',
    prompt: { text: 'lite' },
    delivery: 'steer',
  });
  const fromV1 = { system: [] };
  await legacy['experimental.chat.system.transform']({ model: {} }, fromV1);
  assert.match(fromV1.system[0], /level: lite/);
});

test('frontmatter parser reads folded skill descriptions', () => {
  const parsed = parseFrontmatterFile(path.join(root, 'skills', 'ponytail', 'SKILL.md'));
  assert.equal(parsed.name, 'ponytail');
  assert.match(parsed.description, /Forces the laziest solution/);
  assert.match(parsed.template, /^# Ponytail/);
});

test('frontmatter parser handles LF, CRLF, and missing frontmatter', () => {
  const lf = path.join(tmp, 'lf.md');
  const crlf = path.join(tmp, 'crlf.md');
  const bare = path.join(tmp, 'bare.md');
  fs.writeFileSync(lf, '---\ndescription: do a thing\n---\n\nbody\n');
  fs.writeFileSync(crlf, '---\r\ndescription: do a thing\r\n---\r\n\r\nbody\r\n');
  fs.writeFileSync(bare, 'body only\n');

  for (const file of [lf, crlf]) {
    const parsed = parseFrontmatterFile(file);
    assert.equal(parsed.description, 'do a thing');
    assert.equal(parsed.template, 'body');
  }
  assert.equal(parseFrontmatterFile(bare), null);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
