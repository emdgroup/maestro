/**
 * A working `IntersectionObserver` for tests.
 *
 * happy-dom ships one whose every method is a `// TODO: Implement` no-op, and whose constructor
 * exists — so feature detection cannot tell it apart from a real one, and anything that mounts
 * content on intersection silently never mounts it.
 *
 * The default is **auto-intersect**: an observed element is reported as intersecting on the next
 * microtask, so a suite that does not care about laziness sees content appear as it would in a
 * browser. A suite that is testing laziness calls `setAutoIntersect(false)` and drives
 * `intersect()` itself.
 */

type Entry = Pick<IntersectionObserverEntry, "target" | "isIntersecting" | "intersectionRatio">;

let autoIntersect = true;
const observers = new Set<StubIntersectionObserver>();

class StubIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly scrollMargin: string = "";
  readonly thresholds: readonly number[] = [];
  private readonly targets = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = (options?.root as Element | Document | null) ?? null;
    this.rootMargin = options?.rootMargin ?? "";
    observers.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
    if (autoIntersect) queueMicrotask(() => this.emit([target], true));
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Fire the callback for targets this observer is actually watching. */
  emit(targets: Element[], isIntersecting: boolean) {
    const watched = targets.filter((t) => this.targets.has(t));
    if (watched.length === 0) return;
    const entries = watched.map((target): Entry => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
    }));
    this.callback(entries as IntersectionObserverEntry[], this);
  }

  has(target: Element) {
    return this.targets.has(target);
  }
}

/**
 * Whether observing an element immediately reports it as intersecting. Turn it off to assert that
 * something has *not* mounted yet.
 */
export function setAutoIntersect(value: boolean) {
  autoIntersect = value;
}

/** Report `isIntersecting` for these elements on every observer watching them. */
export function intersect(targets: Element | Element[], isIntersecting = true) {
  const list = Array.isArray(targets) ? targets : [targets];
  for (const observer of observers) observer.emit(list, isIntersecting);
}

/** Every element currently under observation, across all live observers. */
export function observedElements(): Element[] {
  return [...document.querySelectorAll("*")].filter((el) =>
    [...observers].some((observer) => observer.has(el)),
  );
}

export function installIntersectionObserver() {
  globalThis.IntersectionObserver =
    StubIntersectionObserver as unknown as typeof IntersectionObserver;
}

/** Between tests: drop stale observers and restore the permissive default. */
export function resetIntersectionObserver() {
  observers.clear();
  autoIntersect = true;
}
