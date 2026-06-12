export type Map2<K1, K2, V> = Map<K1, Map<K2, V>>;
export type Map3<K1, K2, K3, V> = Map<K1, Map<K2, Map<K3, V>>>;

export function get2<K1, K2, V>(map: Map2<K1, K2, V>, key1: K1, key2: K2): V | undefined {
  return map.get(key1)?.get(key2);
}

export function get3<K1, K2, K3, V>(
  map: Map3<K1, K2, K3, V>,
  key1: K1,
  key2: K2,
  key3: K3
): V | undefined {
  return map.get(key1)?.get(key2)?.get(key3);
}

export function put2<K1, K2, V>(map: Map2<K1, K2, V>, key1: K1, key2: K2, value: V): void {
  let childMap = map.get(key1);

  if (childMap === undefined) {
    childMap = new Map();
    map.set(key1, childMap);
  }

  childMap.set(key2, value);
}

export function put3<K1, K2, K3, V>(
  map: Map3<K1, K2, K3, V>,
  key1: K1,
  key2: K2,
  key3: K3,
  value: V
): void {
  let childMap = map.get(key1);

  if (childMap === undefined) {
    childMap = new Map();
    map.set(key1, childMap);
  }

  put2(childMap, key2, key3, value);
}
