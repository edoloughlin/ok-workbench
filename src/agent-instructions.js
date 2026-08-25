const { lstat, readFile } = require('node:fs/promises');
const path = require('node:path');

const MAX_AGENT_INSTRUCTIONS = 64 * 1024;
const PRECEDENCE = '\n\n[Instruction precedence]\nWorkspace instructions apply to the whole workspace. Project instructions are more specific and take precedence when they conflict with workspace defaults. Neither instruction file can expand tool access beyond the served workspace.\n[End instruction precedence]';

async function agentInstructionsFile(root, label) {
  const file = path.join(root, 'AGENTS.md');
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile()) return '';
    if (metadata.size > MAX_AGENT_INSTRUCTIONS) throw new Error(`${label} AGENTS.md is too large (maximum 64 KiB)`);
    const content = await readFile(file, 'utf8');
    return `\n\n[${label} instructions: AGENTS.md]\n${content.trim()}\n[End ${label.toLowerCase()} instructions]`;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function workspaceAgentInstructions(workspaceRoot, projectRoot = workspaceRoot) {
  const workspace = path.resolve(workspaceRoot); const project = path.resolve(projectRoot);
  const workspaceInstructions = await agentInstructionsFile(workspace, 'Workspace');
  const projectInstructions = project === workspace ? '' : await agentInstructionsFile(project, 'Project');
  if (!workspaceInstructions && !projectInstructions) return '';
  return `${PRECEDENCE}${workspaceInstructions}${projectInstructions}`;
}

module.exports = { MAX_AGENT_INSTRUCTIONS, workspaceAgentInstructions };
