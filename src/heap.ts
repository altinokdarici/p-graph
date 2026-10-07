/** An element that tracks its own position inside an {@link IndexedHeap}. */
export interface HeapItem {
  heapIndex: number;
}

/**
 * Binary heap whose items record their own index, which makes
 * `remove` and `update` of arbitrary items O(log n).
 */
export class IndexedHeap<T extends HeapItem> {
  readonly #items: T[] = [];
  readonly #before: (a: T, b: T) => boolean;

  /** @param before Returns true when `a` must be dequeued before `b`. */
  constructor(before: (a: T, b: T) => boolean) {
    this.#before = before;
  }

  get size(): number {
    return this.#items.length;
  }

  peek(): T | undefined {
    return this.#items[0];
  }

  has(item: T): boolean {
    return item.heapIndex >= 0 && this.#items[item.heapIndex] === item;
  }

  push(item: T): void {
    item.heapIndex = this.#items.length;
    this.#items.push(item);
    this.#siftUp(item.heapIndex);
  }

  pop(): T | undefined {
    const top = this.#items[0];
    if (top !== undefined) {
      this.remove(top);
    }
    return top;
  }

  remove(item: T): boolean {
    if (!this.has(item)) {
      return false;
    }
    const index = item.heapIndex;
    const last = this.#items.pop() as T;
    item.heapIndex = -1;
    if (last !== item) {
      this.#items[index] = last;
      last.heapIndex = index;
      this.#restore(index);
    }
    return true;
  }

  /** Re-establishes heap order after the ordering key of `item` changed. */
  update(item: T): void {
    if (this.has(item)) {
      this.#restore(item.heapIndex);
    }
  }

  clear(): void {
    for (const item of this.#items) {
      item.heapIndex = -1;
    }
    this.#items.length = 0;
  }

  #restore(index: number): void {
    if (!this.#siftUp(index)) {
      this.#siftDown(index);
    }
  }

  #siftUp(index: number): boolean {
    const items = this.#items;
    const item = items[index] as T;
    let moved = false;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = items[parentIndex] as T;
      if (!this.#before(item, parent)) {
        break;
      }
      items[index] = parent;
      parent.heapIndex = index;
      index = parentIndex;
      moved = true;
    }
    items[index] = item;
    item.heapIndex = index;
    return moved;
  }

  #siftDown(index: number): void {
    const items = this.#items;
    const length = items.length;
    const item = items[index] as T;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= length) {
        break;
      }
      const right = left + 1;
      let child = left;
      if (right < length && this.#before(items[right] as T, items[left] as T)) {
        child = right;
      }
      const childItem = items[child] as T;
      if (!this.#before(childItem, item)) {
        break;
      }
      items[index] = childItem;
      childItem.heapIndex = index;
      index = child;
    }
    items[index] = item;
    item.heapIndex = index;
  }
}
