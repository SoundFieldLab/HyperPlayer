import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_API_PROTOCOL_VERSION,
  LOCAL_API_SERVICE,
  isCompatibleLocalApiHealth,
} from '../server/local-api-health.mjs'

test('accepts only the current HyperPlayer local API health contract', () => {
  assert.equal(isCompatibleLocalApiHealth({
    status: 'ok',
    service: LOCAL_API_SERVICE,
    protocolVersion: LOCAL_API_PROTOCOL_VERSION,
  }), true)
})

test('rejects generic, malformed, and incompatible health responses', () => {
  const incompatible = [
    null,
    'ok',
    { status: 'ok' },
    { status: 'ok', service: 'other-service', protocolVersion: LOCAL_API_PROTOCOL_VERSION },
    { status: 'ok', service: LOCAL_API_SERVICE, protocolVersion: LOCAL_API_PROTOCOL_VERSION - 1 },
    { status: 'error', service: LOCAL_API_SERVICE, protocolVersion: LOCAL_API_PROTOCOL_VERSION },
  ]

  for (const response of incompatible) {
    assert.equal(isCompatibleLocalApiHealth(response), false)
  }
})
