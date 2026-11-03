(function createTableOfContentModel(globalScope) {
  if (globalScope.TableOfContentModel) return;

  const GEOMETRY = Object.freeze({
    baseRemPixels: 16,
    stageHeight: 35.5,
    trackTop: 1.875,
    trackBottom: 33.625,
    hitTop: 0,
    hitHeight: 35.5,
    cardEdgeGap: 1.125,
    tickInfluenceSigma: 1.12,
  });

  const MOTION = Object.freeze({
    tickSpringStiffness: 845,
    tickSpringDamping: 58.5,
    tickSpringMaxStep: 1 / 120,
  });

  const LIMITS = Object.freeze({
    maxItems: 200,
  });

  const DEFAULT_ITEMS = Object.freeze(
    Array.from({ length: 38 }, (_, index) =>
      Object.freeze({
        id: `content-${index + 1}`,
        title: `Content item ${index + 1}`,
        description: "Provide sections through the items property.",
      }),
    ),
  );

  function finiteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeIndex(value, count, fallback = 0) {
    const itemCount = Math.max(1, Math.trunc(finiteNumber(count, 1)));
    const index = Math.round(finiteNumber(value, fallback));
    return clamp(index, 0, itemCount - 1);
  }

  function normalizeItems(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new TypeError("table-of-content.items must be a non-empty array.");
    }
    if (value.length > LIMITS.maxItems) {
      throw new RangeError(
        `table-of-content.items supports at most ${LIMITS.maxItems} items.`,
      );
    }

    return Array.from(value, (item, index) => {
      const record = item && typeof item === "object" ? item : {};
      const fallbackId = `content-${index + 1}`;
      const fallbackTitle = `Item ${index + 1}`;
      const id = String(record.id ?? "").trim() || fallbackId;
      const title = String(record.title ?? "").trim() || fallbackTitle;
      const description = String(record.description ?? "");

      return { id, title, description };
    });
  }

  function tickY(index, count) {
    const itemCount = Math.max(1, Math.trunc(finiteNumber(count, 1)));
    const intervals = Math.max(itemCount - 1, 1);
    const normalizedIndex = normalizeIndex(index, itemCount);
    const trackHeight = GEOMETRY.trackBottom - GEOMETRY.trackTop;
    return GEOMETRY.trackTop + (normalizedIndex / intervals) * trackHeight;
  }

  function selectionFromPointer(clientY, rectTop, rectHeight, count) {
    const height = finiteNumber(rectHeight, 0);
    if (height <= 0) return null;

    const pointerY = finiteNumber(clientY, rectTop);
    const top = finiteNumber(rectTop, 0);
    const localY =
      GEOMETRY.hitTop + ((pointerY - top) / height) * GEOMETRY.hitHeight;
    const center = clamp(localY, GEOMETRY.trackTop, GEOMETRY.trackBottom);
    const trackHeight = GEOMETRY.trackBottom - GEOMETRY.trackTop;
    const normalized = (center - GEOMETRY.trackTop) / trackHeight;
    const itemCount = Math.max(1, Math.trunc(finiteNumber(count, 1)));
    const floatIndex = normalized * Math.max(itemCount - 1, 1);

    return Object.freeze({
      center,
      floatIndex,
      index: normalizeIndex(floatIndex, itemCount),
    });
  }

  function tickInfluence(index, floatIndex) {
    if (floatIndex === null || floatIndex === undefined) return 0;
    const distance = finiteNumber(index, 0) - finiteNumber(floatIndex, 0);
    const sigma = GEOMETRY.tickInfluenceSigma;
    return Math.exp(-(distance * distance) / (2 * sigma * sigma));
  }

  function stepSpring(
    state,
    target,
    deltaSeconds,
    stiffness,
    damping,
    maxStep,
  ) {
    const safeTarget = finiteNumber(target, 0);
    const dt = clamp(finiteNumber(deltaSeconds, 0), 0, 1);
    const safeMaxStep = Math.max(finiteNumber(maxStep, 1 / 120), 1 / 1000);
    const steps = Math.max(1, Math.ceil(dt / safeMaxStep));
    const step = dt / steps;
    let value = finiteNumber(state?.value, safeTarget);
    let velocity = finiteNumber(state?.velocity, 0);
    const spring = Math.max(0, finiteNumber(stiffness, 0));
    const drag = Math.max(0, finiteNumber(damping, 0));

    for (let index = 0; index < steps; index += 1) {
      const acceleration = (safeTarget - value) * spring - velocity * drag;
      velocity += acceleration * step;
      value += velocity * step;
    }

    state.value = value;
    state.velocity = velocity;
    return state;
  }

  globalScope.TableOfContentModel = Object.freeze({
    GEOMETRY,
    LIMITS,
    MOTION,
    DEFAULT_ITEMS,
    clamp,
    finiteNumber,
    normalizeIndex,
    normalizeItems,
    selectionFromPointer,
    stepSpring,
    tickInfluence,
    tickY,
  });
})(globalThis);
