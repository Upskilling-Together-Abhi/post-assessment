import { randomUUID } from 'node:crypto';
import { createOnce, readCurrent, setCurrent } from './store';
import type { DemoPreset, Scenario, WaitlistClient } from './types';

export async function newScenario(preset: DemoPreset = 'manual'): Promise<Scenario> {
  const now = Date.now();
  const startAt = now + 2 * 60 * 60_000;
  const people = [
    ['maya', 'Maya Patel', 'MP', 'Haircut', 'Jamie', 1],
    ['alex', 'Alex Morgan', 'AM', 'Haircut', 'Any stylist', 2],
    ['jordan', 'Jordan Lee', 'JL', 'Haircut', 'Jamie', 3],
    ['sam', 'Sam Rivera', 'SR', 'Haircut', 'Any stylist', 4],
    ['casey', 'Casey Chen', 'CC', 'Color', 'Jamie', 0],
    ['riley', 'Riley Brooks', 'RB', 'Haircut', 'Taylor', 1],
    ['avery', 'Avery Wilson', 'AW', 'Haircut', 'Jamie', 0],
  ] as const;
  const clients: WaitlistClient[] = people.map(([id, name, initials, service, stylist, order]) => ({
    id, name, initials, service, stylist, joinedAt: now - (7 - order) * 86_400_000,
    availableFrom: id === 'avery' ? startAt + 60 * 60_000 : startAt - 60 * 60_000,
    availableTo: startAt + 3 * 60 * 60_000, durationMinutes: 45,
  }));
  const scenario: Scenario = {
    opening: { id: randomUUID(), startAt, service: 'Haircut', stylist: 'Jamie', durationMinutes: 45, responseWindowMs: preset === 'manual' ? 30_000 : 10_000, simulated: true, demoPreset: preset },
    clients,
  };
  await createOnce('scenarios', scenario.opening.id, scenario);
  await setCurrent(scenario.opening.id);
  return scenario;
}
let creating: Promise<Scenario> | undefined;
export async function currentScenario(): Promise<Scenario> {
  const existing = await readCurrent();
  if (existing) return existing;
  creating ??= newScenario().finally(() => { creating = undefined; });
  return creating;
}
