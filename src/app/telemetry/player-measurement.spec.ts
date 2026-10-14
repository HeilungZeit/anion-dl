import { beforeEach, describe, expect, it } from 'bun:test';

import { PlayerMeasurement, PlayerMeasurementEvent } from './player-measurement';

describe('PlayerMeasurement', () => {
  let time: number;
  let allowed: boolean;
  let events: PlayerMeasurementEvent[];
  let measurement: PlayerMeasurement;
  beforeEach(() => {
    time = 0;
    allowed = true;
    events = [];
    let id = 0;
    measurement = new PlayerMeasurement(
      (event) => events.push(event),
      () => allowed,
      () => time,
      () => `attempt-${++id}`,
    );
  });
  const named = (name: string) => events.filter((event) => event.name === name);
  const tick = (position: number, elapsed = 1000, active = true, seeking = false) => {
    time += elapsed;
    measurement.observe(position, active, seeking);
  };

  it('подтверждает движение видео, но не создание плеера и не неподвижный play', () => {
    expect(events).toEqual([]);
    measurement.request();
    tick(10);
    tick(10);
    expect(named('started').length).toBe(0);
    tick(11);
    expect(named('started')[0]?.durationMs).toBe(3000);
  });

  it('пауза, seek и повторный play не завышают число запусков и время просмотра', () => {
    measurement.request();
    tick(0);
    tick(1);
    measurement.pause();
    tick(100, 60_000, false);
    measurement.request();
    tick(500, 1000, true, true);
    tick(500);
    tick(501);
    measurement.close();
    expect(named('requested').length).toBe(1);
    expect(named('started').length).toBe(1);
    expect(named('watch').reduce((sum, event) => sum + (event.durationMs ?? 0), 0)).toBe(2000);
  });

  it('не засчитывает большой скачок позиции и сон вкладки', () => {
    measurement.request();
    tick(0);
    tick(300);
    tick(301, 60_000);
    expect(named('started').length).toBe(0);
    tick(302);
    measurement.close();
    expect(named('watch')[0]?.durationMs).toBe(1000);
  });

  it('считает буферизацию после запуска, исключает начальное ожидание и заканчивает на паузе', () => {
    measurement.request();
    measurement.waiting();
    time += 5000;
    measurement.playing();
    expect(named('buffer').length).toBe(0);
    tick(0);
    tick(1);
    measurement.waiting();
    measurement.waiting();
    time += 2000;
    measurement.pause();
    time += 10000;
    measurement.playing();
    expect(named('buffer').length).toBe(1);
    expect(named('buffer')[0]?.durationMs).toBe(2000);
  });

  it('ошибка не дублируется, явный повтор создаёт другую попытку', () => {
    measurement.request();
    measurement.error('network');
    measurement.error('network');
    measurement.request();
    tick(0);
    tick(1);
    expect(named('error').length).toBe(1);
    expect(named('requested').length).toBe(2);
    expect(named('started')[0]?.attemptId).toBe('attempt-2');
  });

  it('до согласия ничего не измеряет, при отзыве не переносит время и ожидание', () => {
    allowed = false;
    measurement.request();
    tick(0);
    tick(1);
    measurement.feature('quality', '720');
    expect(events).toEqual([]);
    allowed = true;
    tick(2);
    tick(3);
    expect(named('started')[0]?.durationMs).toBeUndefined();
    measurement.waiting();
    allowed = false;
    tick(4);
    time += 5000;
    allowed = true;
    measurement.playing();
    expect(named('buffer').length).toBe(0);
  });

  it('сброс согласия очищает ожидание даже если видео не присылало событий в этот период', () => {
    measurement.request();
    tick(0);
    tick(1);
    measurement.waiting();
    time += 2000;
    measurement.discard();
    time += 10000;
    measurement.playing();
    tick(2);
    tick(3);
    expect(named('buffer').length).toBe(0);
    expect(named('started')[1]?.durationMs).toBeUndefined();
  });

  it('настройки, прочитанные на каждом timeupdate, учитывает один раз на режим', () => {
    measurement.feature('quality', '720', true);
    measurement.feature('quality', '720', true);
    measurement.feature('quality', '480', true);
    expect(named('feature').length).toBe(2);
  });
});
