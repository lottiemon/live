// lottieConverter.js

// IMPORTANT: This module assumes JSZip is available in the global scope (e.g., loaded via a <script> tag before this module)

/**
 * Reads a File object as an ArrayBuffer.
 * @param {File} file - The file to read.
 * @returns {Promise<ArrayBuffer>} A promise that resolves with the ArrayBuffer.
 */
 function readFileAsArrayBuffer(file) {
     return new Promise((resolve, reject) => {
         const reader = new FileReader();
         reader.onload = () => resolve(reader.result);
         reader.onerror = error => reject(error);
         reader.readAsArrayBuffer(file);
     });
 }

/**
 * Reads a File object as text.
 * @param {File} file - The file to read.
 * @returns {Promise<string>} A promise that resolves with the text content.
 */
 function readFileAsText(file) {
     return new Promise((resolve, reject) => {
         const reader = new FileReader();
         reader.onload = () => resolve(reader.result);
         reader.onerror = error => reject(error);
         reader.readAsText(file);
     });
 }


/**
 * Guesses the MIME type based on the file extension.
 * @param {string} filename - The name of the file.
 * @returns {string} The guessed MIME type.
 */
 function getMimeType(filename) {
     const ext = filename.split('.').pop().toLowerCase();
     switch (ext) {
         case 'png': return 'image/png';
         case 'jpg':
         case 'jpeg': return 'image/jpeg';
         case 'gif': return 'image/gif';
         case 'webp': return 'image/webp';
         case 'svg': return 'image/svg+xml';
         default: return 'application/octet-stream'; // Fallback for unknown types
     }
 }

/**
 * Embeds assets from the assetsMap into a given Lottie animation JSON data object.
 * @param {object} animationJsonData - The Lottie animation JSON data (as an object) to modify.
 * @param {Map<string, string>} assetsMap - A map of asset filenames to their base64 data.
 */
 function embedAssetsInAnimation(animationJsonData, assetsMap) {
     if (animationJsonData.assets && Array.isArray(animationJsonData.assets)) {
         for (const asset of animationJsonData.assets) {
             if (asset.e === 1) { // Already embedded or an external link intended to be kept
                 continue;
             }
             const assetFilename = asset.p; // asset.p is typically the filename like "image_0.png"
             const embeddedData = assetsMap.get(assetFilename);

             if (embeddedData) {
                 asset.u = ""; // Clear folder path as it's now embedded
                 asset.p = embeddedData; // Replace filename with base64 data URI
                 asset.e = 1; // Mark as embedded
             } else {
                 console.warn(`Asset "${assetFilename}" referenced in animation JSON not found in the archive's assets. It might be an external URL or missing.`);
             }
         }
     }
 }


/**
 * Converts a .lottie file (zip archive) into an array of Lottie JSON strings,
 * each with embedded assets.
 * @param {File} dotLottieFile - The .lottie file to convert.
 * @returns {Promise<string[]>} A promise that resolves with an array of Lottie JSON strings.
 */
 export async function convertDotLottieToJson(dotLottieFile) {
     if (typeof JSZip === 'undefined') {
         throw new Error("JSZip library is not loaded. Please ensure it's available in the global scope.");
     }

     const arrayBuffer = await readFileAsArrayBuffer(dotLottieFile);
     const zip = new JSZip();
     const loadedZip = await zip.loadAsync(arrayBuffer);

     const processedAnimations = []; // Array to store {originalPath, jsonString}
     const assetsMap = new Map();
     const allJsonFileContents = new Map(); // Map to store all parsed JSON file contents: Map<filePath, parsedJsonDataObject>

     // Step 1: Extract all assets and all JSON file contents
     for (const filename in loadedZip.files) {
         const fileEntry = loadedZip.files[filename];
         if (fileEntry.dir) continue;

         if (filename.endsWith('.json')) {
             const jsonContent = await fileEntry.async('text');
             try {
                 allJsonFileContents.set(filename, JSON.parse(jsonContent));
             } catch (e) {
                 console.warn(`Could not parse JSON file: ${filename}`, e);
             }
         } else if (
             filename.startsWith('assets/') || filename.startsWith('images/') ||
             filename.startsWith('i/')
         ) {
             const assetName = filename.split('/').pop();
             const base64Data = await fileEntry.async('base64');
             const mimeType = getMimeType(filename);
             assetsMap.set(assetName, `data:${mimeType};base64,${base64Data}`);
         }
     }

     // Step 2: Try to process animations based on manifest.json
     let manifest = allJsonFileContents.get('manifest.json');
     if (manifest && manifest.animations && Array.isArray(manifest.animations)) {
         for (const animEntry of manifest.animations) {
             let animationJsonPath = animEntry.src; // Bodymovin-rlottie often uses 'src'
             if (!animationJsonPath && animEntry.id) {
                 // Common convention: animations/<id>.json or <id>.json if at root
                 if (allJsonFileContents.has(`animations/${animEntry.id}.json`)) {
                    animationJsonPath = `animations/${animEntry.id}.json`;
                 } else if (allJsonFileContents.has(`${animEntry.id}.json`)) {
                    animationJsonPath = `${animEntry.id}.json`;
                 } else {
                     // Try to find any JSON file that might match the ID if no explicit path is given
                     // This is a more speculative fallback
                     for (const path of allJsonFileContents.keys()) {
                         if (path.includes(animEntry.id) && path.endsWith('.json')) {
                             animationJsonPath = path;
                             break;
                         }
                     }
                 }
             }

             if (animationJsonPath && allJsonFileContents.has(animationJsonPath)) {
                 const originalAnimationJsonData = allJsonFileContents.get(animationJsonPath);
                 const animationJsonDataCopy = JSON.parse(JSON.stringify(originalAnimationJsonData)); // Deep clone
                 embedAssetsInAnimation(animationJsonDataCopy, assetsMap);
                 processedAnimations.push({
                     originalPath: animationJsonPath,
                     jsonString: JSON.stringify(animationJsonDataCopy)
                 });
             } else {
                 console.warn(`Animation with ID "${animEntry.id}" (path: ${animationJsonPath || 'unknown'}) mentioned in manifest not found or path is missing.`);
             }
         }
     }

     // Step 3: Fallback if no animations were processed via manifest
     if (processedAnimations.length === 0) {
         console.warn("No animations processed via manifest.json, or manifest not found/valid. Attempting fallback.");
         let foundFallback = false;
         const fallbackPaths = ['animation.json', 'data.json']; // Common root-level names
         allJsonFileContents.forEach((_, key) => { // Add JSONs from typical animation folders
             if (key.startsWith('animations/') || key.startsWith('a/')) {
                 if (!fallbackPaths.includes(key)) fallbackPaths.push(key);
             }
         });

         for (const path of fallbackPaths) {
             if (allJsonFileContents.has(path)) {
                 const originalAnimationJsonData = allJsonFileContents.get(path);
                 // Basic check if it looks like a Lottie file
                 if (originalAnimationJsonData && originalAnimationJsonData.v) {
                     const animationJsonDataCopy = JSON.parse(JSON.stringify(originalAnimationJsonData));
                     embedAssetsInAnimation(animationJsonDataCopy, assetsMap);
                     processedAnimations.push({
                         originalPath: path,
                         jsonString: JSON.stringify(animationJsonDataCopy)
                     });
                     foundFallback = true;
                     // If no manifest was present, and we found one of these, assume it's the only one.
                     if (!manifest) break;
                 }
             }
         }
         // Very generic fallback: if still nothing and no manifest, take the first valid Lottie JSON found
         if (!foundFallback && !manifest && allJsonFileContents.size > 0) {
             for (const [path, data] of allJsonFileContents.entries()) {
                 if (data && data.v) { // Check for Lottie version property 'v'
                     const animationJsonDataCopy = JSON.parse(JSON.stringify(data));
                     embedAssetsInAnimation(animationJsonDataCopy, assetsMap);
                     processedAnimations.push({
                         originalPath: path,
                         jsonString: JSON.stringify(animationJsonDataCopy)
                     });
                     console.warn(`Used generic fallback: processed first valid JSON found at ${path} as an animation.`);
                     break;
                 }
             }
         }
     }

     if (processedAnimations.length === 0) {
         throw new Error("Could not find any Lottie animation JSON data within the .lottie archive.");
     }

     return processedAnimations;
 }

/**
 * Converts a Lottie JSON file into a .lottie Blob (zip archive).
 * @param {File} lottieJsonFile - The Lottie JSON file to convert.
 * @returns {Promise<Blob>} A promise that resolves with the .lottie file as a Blob.
 */
export async function convertJsonToDotLottie(lottieJsonFile) {
    if (typeof JSZip === 'undefined') {
        throw new Error("JSZip library is not loaded. Please ensure it's available in the global scope.");
    }

    const jsonString = await readFileAsText(lottieJsonFile);
    const animationJsonData = JSON.parse(jsonString);

    const zip = new JSZip();

    const animationPathInZip = 'animations/data.json';
    zip.file(animationPathInZip, JSON.stringify(animationJsonData));

    if (animationJsonData.assets && Array.isArray(animationJsonData.assets)) {
        const assetsFolder = '/images/';

        for (const asset of animationJsonData.assets) {
            if (asset.e === 1 && asset.p && asset.p.startsWith('data:')) {
                const base64Content = asset.p.split(',')[1];
                const mimeType = asset.p.split(',')[0].split(':')[1].split(';')[0];
                const ext = mimeType.split('/')[1];

                const baseName = asset.id || 'asset';
                const cleanBaseName = baseName.replace(/[^\w.-]/g, '_');
                const assetFilename = `${cleanBaseName}.${ext.replace('+xml', '')}`;

                zip.file(assetsFolder.substring(1) + assetFilename, base64Content, { base64: true });

                asset.u = assetsFolder;
                asset.p = assetFilename;
                asset.e = 0;
            }
        }
        zip.file(animationPathInZip, JSON.stringify(animationJsonData));
    }

    // Generate Manifest.json strictly as requested, removing 'src' and 'activeAnimationId'
    const manifestString = '{"version":"1","generator":"@lottiemon/hardgenerated","author":"lottiemon","animations":[{"id":"data"}]}';
    const manifest = JSON.parse(manifestString);

    if (manifest.animations && Array.isArray(manifest.animations) && manifest.animations.length > 0) {
        delete manifest.animations[0].src;
    } else {
        console.warn("Provided manifest string does not contain an animations array or it's empty. Adding default animation entry without 'src'.");
        manifest.animations = [{
            id: "data",
            autoplay: true,
            loop: true,
            speed: 1.0,
            direction: 1,
            playMode: "normal"
        }];
    }
    delete manifest.activeAnimationId;

    zip.file('manifest.json', JSON.stringify(manifest));

    return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}
