/**
 * In-memory coordinator — manages agent state and message routing.
 * Pure TypeScript replacement for the former Rust/WASM coordinator.
 */

import type { AgentConfig, AgentState, AgentStatus, Message } from './types'

interface InternalAgentState {
  config: AgentConfig
  status: AgentStatus
  messageCount: number
  unreadCount: number
}

let agents = new Map<string, InternalAgentState>()
let messages: Message[] = []
let isRunning = false

// ─── Agent management ──────────────────────────────────────────────────────────

export function addAgent(cfg: AgentConfig): void {
  agents.set(cfg.id, {
    config: cfg,
    status: 'idle',
    messageCount: 0,
    unreadCount: 0,
  })
}

export function getAgents(): AgentState[] {
  return [...agents.values()]
    .sort((a, b) => a.config.id.localeCompare(b.config.id))
    .map((a) => ({
      ...a.config,
      status: a.status,
      messageCount: a.messageCount,
      unreadCount: a.unreadCount,
    }))
}

// ─── Message routing ───────────────────────────────────────────────────────────

export function routeMessage(msg: Omit<Message, 'id'>): string {
  const id = crypto.randomUUID()
  const message: Message = { ...msg, id }

  // Increment sender's outgoing count
  const sender = agents.get(msg.fromAgent)
  if (sender) sender.messageCount++

  // Increment recipient's unread count
  if (msg.toAgent !== 'user' && msg.toAgent !== 'broadcast') {
    const recipient = agents.get(msg.toAgent)
    if (recipient) recipient.unreadCount++
  }

  messages.push(message)
  return id
}

export function getMessagesFor(agentId: string): Message[] {
  return messages.filter((m) => m.toAgent === agentId || m.toAgent === 'broadcast')
}

export function getMessageCountFor(agentId: string): number {
  return messages.filter((m) => m.toAgent === agentId || m.toAgent === 'broadcast').length
}

// ─── Status ────────────────────────────────────────────────────────────────────

export function updateAgentStatus(agentId: string, status: AgentStatus): void {
  const agent = agents.get(agentId)
  if (agent) agent.status = status
}

export function getAgentStatus(agentId: string): AgentStatus {
  return agents.get(agentId)?.status ?? 'idle'
}

export function clearSession(): void {
  messages = []
  isRunning = false
  for (const agent of agents.values()) {
    agent.status = 'idle'
    agent.messageCount = 0
    agent.unreadCount = 0
  }
}

export function getRunning(): boolean {
  return isRunning
}

export function setRunning(running: boolean): void {
  isRunning = running
}
