export type Cm93Scale = {
  code: string;
  fileCount: number;
};

export type Cm93DatasetSummary = {
  rootName: string;
  fileCount: number;
  regionCount: number;
  regionIds: string[];
  scales: Cm93Scale[];
  editionDates: string[];
  hasObjectDictionary: boolean;
  hasAttributeDictionary: boolean;
  isLikelyCm93V2: boolean;
  warnings: string[];
};

/**
 * Inspect a CM93 V2 directory selected with the browser's directory picker.
 * This is intentionally an inventory/validation step: CM93 cell decoding and
 * portrayal are separate from recognizing the directory layout.
 */
export function inspectCm93Files(files: FileList | File[]): Cm93DatasetSummary {
  const entries = Array.from(files).map((file) => {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { path: path.replace(/\\/g, '/'), lowerPath: path.replace(/\\/g, '/').toLowerCase() };
  });

  if (entries.length === 0) {
    throw new Error('Select the extracted CM93 V2 chart directory, not an empty folder.');
  }

  const firstPath = entries[0].path;
  const rootName = firstPath.includes('/') ? firstPath.split('/')[0] : 'Selected files';
  const rootPrefix = firstPath.includes('/') ? `${rootName}/`.toLowerCase() : '';
  const relativePaths = entries.map(({ lowerPath }) =>
    rootPrefix && lowerPath.startsWith(rootPrefix) ? lowerPath.slice(rootPrefix.length) : lowerPath,
  );

  const regionIds = [...new Set(relativePaths
    .map((path) => path.split('/')[0])
    .filter((segment) => /^\\d{8}$/.test(segment)))].sort();

  const scaleCounts = new Map<string, number>([['Z', 0], ...'ABCDEFG'.split('').map((code) => [code, 0] as [string, number])]);
  for (const path of relativePaths) {
    const parts = path.split('/');
    const regionIndex = parts.findIndex((part) => /^\\d{8}$/.test(part));
    if (regionIndex < 0) continue;
    const scale = parts[regionIndex + 1]?.toUpperCase();
    if (scale && scaleCounts.has(scale) && parts.length > regionIndex + 2) {
      scaleCounts.set(scale, (scaleCounts.get(scale) ?? 0) + 1);
    }
  }

  const editionDates = [...new Set(relativePaths
    .map((path) => path.match(/(?:^|\\/)(\\d{8})\\.exd$/i)?.[1])
    .filter((date): date is string => Boolean(date)))].sort();

  const hasObjectDictionary = relativePaths.some((path) => /(?:^|\\/)cm93obj\\.dic$/i.test(path));
  const hasAttributeDictionary = relativePaths.some((path) => /(?:^|\\/)cm93attr\\.dic$/i.test(path));
  const populatedScales = [...scaleCounts.entries()].filter(([, count]) => count > 0);
  const isLikelyCm93V2 = regionIds.length > 0 && editionDates.length > 0 &&
    hasObjectDictionary && hasAttributeDictionary && populatedScales.length > 0;

  const warnings: string[] = [];
  if (!editionDates.length) warnings.push('No YYYYMMDD.EXD edition marker was found.');
  if (!hasObjectDictionary) warnings.push('CM93OBJ.DIC object dictionary is missing.');
  if (!hasAttributeDictionary) warnings.push('CM93ATTR.DIC attribute dictionary is missing.');
  if (!regionIds.length) warnings.push('No eight-digit geographic region directories were found.');
  if (!populatedScales.length) warnings.push('No chart files were found in scale directories A–G.');

  return {
    rootName,
    fileCount: entries.length,
    regionCount: regionIds.length,
    regionIds,
    scales: [...scaleCounts.entries()]
      .filter(([code, fileCount]) => code === 'Z' ? fileCount > 0 : fileCount > 0)
      .map(([code, fileCount]) => ({ code, fileCount })),
    editionDates,
    hasObjectDictionary,
    hasAttributeDictionary,
    isLikelyCm93V2,
    warnings,
  };
}
