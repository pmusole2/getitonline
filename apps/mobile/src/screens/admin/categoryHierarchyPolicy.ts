export type CategoryParentId = string | null | undefined;

export function didCategoryParentChange(
  currentParentId: CategoryParentId,
  nextParentId: CategoryParentId,
): boolean {
  return (currentParentId ?? null) !== (nextParentId ?? null);
}
