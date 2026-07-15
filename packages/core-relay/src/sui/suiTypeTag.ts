import { TypeTagSerializer } from '@mysten/sui/bcs';

/** Parse one current Sui TypeTag and return its canonical SDK representation. */
export function canonicalizeSuiTypeTag(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Invalid Sui type tag');
  }
  try {
    return TypeTagSerializer.tagToString(TypeTagSerializer.parseFromStr(value, true));
  } catch {
    throw new TypeError('Invalid Sui type tag');
  }
}
