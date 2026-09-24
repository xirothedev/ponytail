// ponytail — OpenCode V1 and V2 plugin.

import { Plugin } from '@opencode/plugin';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getPonytailInstructions } = require('../../hooks/ponytail-instructions');
const { getDefaultMode, getOpenCodeStatePath, normalizeMode, RUNTIME_MODES } = require('../../hooks/ponytail-config');
const { parseFrontmatterFile } = require('./ponytail-frontmatter.cjs');

const commandDir = path.join(__dirname, '..', 'commands');
const skillsDir = path.resolve(__dirname, '../../skills');
const statePath = getOpenCodeStatePath();
const acceptedModes = RUNTIME_MODES.join(', ');

function readMode() {
  try {
    return normalizeMode(fs.readFileSync(statePath, 'utf8').trim()) || getDefaultMode();
  } catch {
    return getDefaultMode();
  }
}

function writeMode(mode) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, mode);
}

function commands() {
  return fs.readdirSync(commandDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ ...parseFrontmatterFile(path.join(commandDir, file)), name: path.basename(file, '.md') }))
    .filter((command) => command.description);
}

function skills() {
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const location = path.join(skillsDir, entry.name, 'SKILL.md');
      return { id: entry.name, location, ...parseFrontmatterFile(location) };
    })
    .filter((skill) => skill.description);
}

function applyMode(args) {
  const current = readMode();
  if (!args) return { text: `Current Ponytail mode: ${current}. Do not change it.` };
  const mode = normalizeMode(args);
  if (!mode) {
    return { text: `Ponytail mode remains ${current}. Use one of: ${acceptedModes}.` };
  }
  writeMode(mode);
  return { mode, text: `Ponytail mode switched to ${mode}. Confirm it in one short line.` };
}

function promptText(template, args) {
  const text = template.replaceAll('$ARGUMENTS', args);
  return args && !template.includes('$ARGUMENTS') ? `${text}\n\nArguments: ${args}` : text;
}

async function setup(ctx) {
  const commandDefinitions = commands();
  const skillDefinitions = skills();

  await ctx.command.transform((editor) => {
    for (const command of commandDefinitions) {
      editor.add({
        name: command.name,
        description: command.description,
        execute: async ({ sessionID, prompt, delivery }) => {
          const args = String(prompt.text || '').trim();
          let text = promptText(command.template, args);
          if (command.name === 'ponytail') text = applyMode(args).text;
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
        },
      });
    }
  });

  await ctx.skill.transform((editor) => {
    for (const skill of skillDefinitions) {
      editor.add({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
        path: skill.location,
        content: skill.template,
      });
    }
  });

  await ctx.session.hook('context', (event) => {
    const mode = readMode();
    if (mode === 'off') return;
    event.system.push({ type: 'text', text: getPonytailInstructions(mode) });
  });
}

async function server({ client } = {}) {
  const log = (message) => {
    try {
      client?.app?.log({ body: { service: 'ponytail', level: 'info', message } });
    } catch {}
  };

  return {
    config: async (config) => {
      config.command ||= {};
      for (const command of commands()) {
        config.command[command.name] = {
          description: command.description,
          template: command.template,
        };
      }
      config.skills ||= {};
      config.skills.paths ||= [];
      if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    },

    'experimental.chat.system.transform': async (_input, output) => {
      const mode = readMode();
      if (mode === 'off') return;
      const instructions = getPonytailInstructions(mode);
      if (output.system.length > 0) {
        output.system[output.system.length - 1] += `\n\n${instructions}`;
      } else {
        output.system.push(instructions);
      }
    },

    'command.execute.before': async (input, output) => {
      if (input?.command !== 'ponytail') return;
      const result = applyMode(String(input.arguments || '').trim());
      output.parts = [{ type: 'text', text: result.text }];
      if (result.mode) log(`ponytail ${result.mode}`);
    },
  };
}

export default {
  ...Plugin.define({ id: 'ponytail', setup }),
  server,
};
