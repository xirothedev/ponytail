'use strict';

// ponytail Markdown frontmatter parser.

const fs = require('fs');

function field(source, name) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(new RegExp(`^${name}:\\s*(.*)$`));
    if (!match) continue;

    const value = match[1].trim();
    if (value !== '>' && value !== '|') {
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
      }
      return value;
    }

    const block = [];
    while (index + 1 < lines.length && (!lines[index + 1].trim() || /^\s+/.test(lines[index + 1]))) {
      if (lines[index + 1].trim()) block.push(lines[index + 1].trim());
      index++;
    }
    return value === '>' ? block.join(' ') : block.join('\n');
  }
  return undefined;
}

function parseFrontmatterFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  return {
    name: field(match[1], 'name'),
    description: field(match[1], 'description'),
    template: match[2].trim(),
  };
}

module.exports = { parseFrontmatterFile };
