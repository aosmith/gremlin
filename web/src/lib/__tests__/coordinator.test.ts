import { describe, it, expect, beforeEach } from 'vitest'
import * as coord from '../coordinator'
import type { AgentConfig } from '../types'

function makeAgent(id: string, role: 'orchestrator' | 'worker' | 'synthesizer' = 'worker'): AgentConfig {
  return {
    id,
    name: id,
    role,
    systemPrompt: 'test',
    color: '#fff',
  }
}

describe('coordinator', () => {
  beforeEach(() => {
    coord.clearSession()
  })

  describe('addAgent / getAgents', () => {
    it('adds an agent and retrieves it', () => {
      coord.addAgent(makeAgent('a1'))
      const agents = coord.getAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].id).toBe('a1')
      expect(agents[0].status).toBe('idle')
      expect(agents[0].messageCount).toBe(0)
      expect(agents[0].unreadCount).toBe(0)
    })

    it('returns agents sorted by id', () => {
      // clearSession keeps agents but resets state — add fresh agents
      coord.addAgent(makeAgent('charlie'))
      coord.addAgent(makeAgent('alice'))
      coord.addAgent(makeAgent('bob'))
      const ids = coord.getAgents().map((a) => a.id)
      // a1 persists from previous test since clearSession doesn't remove agents
      expect(ids).toEqual(['a1', 'alice', 'bob', 'charlie'])
    })
  })

  describe('routeMessage', () => {
    it('routes a message and increments counts', () => {
      coord.addAgent(makeAgent('sender'))
      coord.addAgent(makeAgent('receiver'))

      const id = coord.routeMessage({
        fromAgent: 'sender',
        toAgent: 'receiver',
        content: 'hello',
        timestamp: Date.now(),
        type: 'message',
      })

      expect(id).toBeTruthy()

      const agents = coord.getAgents()
      const sender = agents.find((a) => a.id === 'sender')!
      const receiver = agents.find((a) => a.id === 'receiver')!
      expect(sender.messageCount).toBe(1)
      expect(receiver.unreadCount).toBe(1)
    })

    it('does not increment unread for broadcast messages', () => {
      coord.addAgent(makeAgent('a1'))
      coord.routeMessage({
        fromAgent: 'a1',
        toAgent: 'broadcast',
        content: 'hi all',
        timestamp: Date.now(),
        type: 'message',
      })
      const agents = coord.getAgents()
      expect(agents[0].unreadCount).toBe(0)
    })

    it('does not increment unread for user-targeted messages', () => {
      coord.addAgent(makeAgent('a1'))
      coord.routeMessage({
        fromAgent: 'a1',
        toAgent: 'user',
        content: 'result',
        timestamp: Date.now(),
        type: 'result',
      })
      const agents = coord.getAgents()
      expect(agents[0].unreadCount).toBe(0)
    })
  })

  describe('getMessagesFor', () => {
    it('returns messages addressed to agent or broadcast', () => {
      coord.addAgent(makeAgent('a1'))
      coord.addAgent(makeAgent('a2'))

      coord.routeMessage({ fromAgent: 'a1', toAgent: 'a2', content: 'direct', timestamp: 1, type: 'message' })
      coord.routeMessage({ fromAgent: 'a1', toAgent: 'broadcast', content: 'bcast', timestamp: 2, type: 'message' })
      coord.routeMessage({ fromAgent: 'a2', toAgent: 'a1', content: 'reply', timestamp: 3, type: 'message' })

      const msgsForA2 = coord.getMessagesFor('a2')
      expect(msgsForA2).toHaveLength(2) // direct + broadcast
      expect(msgsForA2.map((m) => m.content)).toEqual(['direct', 'bcast'])
    })
  })

  describe('getMessageCountFor', () => {
    it('returns correct count', () => {
      coord.addAgent(makeAgent('a1'))
      coord.addAgent(makeAgent('a2'))

      coord.routeMessage({ fromAgent: 'a1', toAgent: 'a2', content: 'x', timestamp: 1, type: 'message' })
      coord.routeMessage({ fromAgent: 'a1', toAgent: 'a2', content: 'y', timestamp: 2, type: 'message' })

      expect(coord.getMessageCountFor('a2')).toBe(2)
      expect(coord.getMessageCountFor('a1')).toBe(0)
    })
  })

  describe('updateAgentStatus', () => {
    it('updates status correctly', () => {
      coord.addAgent(makeAgent('a1'))
      expect(coord.getAgentStatus('a1')).toBe('idle')

      coord.updateAgentStatus('a1', 'running')
      expect(coord.getAgentStatus('a1')).toBe('running')

      coord.updateAgentStatus('a1', 'done')
      expect(coord.getAgentStatus('a1')).toBe('done')
    })

    it('returns idle for unknown agent', () => {
      expect(coord.getAgentStatus('nonexistent')).toBe('idle')
    })
  })

  describe('clearSession', () => {
    it('resets all state', () => {
      coord.addAgent(makeAgent('a1'))
      coord.updateAgentStatus('a1', 'running')
      coord.routeMessage({ fromAgent: 'a1', toAgent: 'user', content: 'x', timestamp: 1, type: 'message' })
      coord.setRunning(true)

      coord.clearSession()

      const agents = coord.getAgents()
      expect(agents[0].status).toBe('idle')
      expect(agents[0].messageCount).toBe(0)
      expect(coord.getRunning()).toBe(false)
      expect(coord.getMessagesFor('a1')).toHaveLength(0)
    })
  })

  describe('running state', () => {
    it('tracks running state', () => {
      expect(coord.getRunning()).toBe(false)
      coord.setRunning(true)
      expect(coord.getRunning()).toBe(true)
      coord.setRunning(false)
      expect(coord.getRunning()).toBe(false)
    })
  })
})
