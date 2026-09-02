import { describe, expect, it } from 'bun:test';
import { dependencyCycle, dependencyPath, transitiveDependents } from '../src/dependency-graph.js';

// c → b → a: c depends on b, b depends on a.
const edges = new Map<string, readonly string[]>([['b', ['a']], ['c', ['b']], ['d', ['a']]]);

describe('dependencyPath', () => {
  it('walks dependsOn edges and returns the ordered path, or null', () => {
    expect(dependencyPath('c', 'a', edges)).toEqual(['c', 'b', 'a']);
    expect(dependencyPath('a', 'c', edges)).toBeNull();
    expect(dependencyPath('d', 'b', edges)).toBeNull();
    expect(dependencyPath('a', 'a', edges)).toEqual(['a']);
  });
});

describe('dependencyCycle', () => {
  it('names the loop a proposed edge would close and accepts acyclic proposals', () => {
    expect(dependencyCycle('a', ['c'], edges)).toEqual(['a', 'c', 'b', 'a']);
    expect(dependencyCycle('a', ['d'], edges)).toEqual(['a', 'd', 'a']);
    expect(dependencyCycle('c', ['b', 'd'], edges)).toBeNull();
    expect(dependencyCycle('a', [], edges)).toBeNull();
  });

  it('judges the proposal, not the stale entry it replaces', () => {
    const stale = new Map<string, readonly string[]>([['a', ['b']], ['b', ['a']]]);
    expect(dependencyCycle('a', [], stale)).toBeNull();
    expect(dependencyCycle('a', ['b'], stale)).toEqual(['a', 'b', 'a']);
  });
});

describe('transitiveDependents', () => {
  it('collects everything that reaches the workspace through dependsOn', () => {
    expect([...transitiveDependents('a', edges)].sort()).toEqual(['b', 'c', 'd']);
    expect([...transitiveDependents('b', edges)]).toEqual(['c']);
    expect(transitiveDependents('c', edges).size).toBe(0);
  });
});
