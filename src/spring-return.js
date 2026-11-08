// A damped, slightly under-critical spring to ease drag inputs back toward
// the MOC default. Driven before Cubism physics, never as an after-physics lock.
export function createSpring(value, target, span) {
  return { value, target, velocity: 0, span: Math.max(0.0001, Math.abs(span)) };
}
export function advanceSpring(spring, dtSeconds) {
  // Small integration steps keep motion stable across varying frame rates.
  const dt = Math.max(0, Math.min(0.06, Number(dtSeconds) || 0));
  const slices = Math.max(1, Math.ceil(dt / (1 / 120)));
  const step = dt / slices;
  for (let i=0; i<slices; i++) {
    const acceleration = -98 * (spring.value - spring.target) - 16 * spring.velocity;
    spring.velocity += acceleration * step;
    spring.value += spring.velocity * step;
  }
  const done = Math.abs(spring.value - spring.target) <= spring.span * 0.0015 &&
    Math.abs(spring.velocity) <= spring.span * 0.02;
  if (done) { spring.value = spring.target; spring.velocity = 0; }
  return done;
}
