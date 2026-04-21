const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

// Find the project root (monorepo root)
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
const mobileNodeModules = path.resolve(projectRoot, 'node_modules');
const rootNodeModules = path.resolve(monorepoRoot, 'node_modules');

function resolveWorkspaceModule(moduleName) {
  const localPath = path.join(mobileNodeModules, moduleName);
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  return path.join(rootNodeModules, moduleName);
}

const sharedPackageRoot = path.resolve(monorepoRoot, 'packages/shared');
const convexRoot = path.resolve(monorepoRoot, 'convex');

// 1. Watch the monorepo folders Metro must follow outside the app root
config.watchFolders = [
  convexRoot,
  sharedPackageRoot,
];

// 2. Let Metro know where to resolve packages from
// Prioritize local node_modules to avoid react-dom issues
config.resolver.nodeModulesPaths = [mobileNodeModules, rootNodeModules].filter(fs.existsSync);

// 3. Redirect react-dom to our shim (for web-focused dependencies like @clerk/clerk-react)
config.resolver.extraNodeModules = {
  'react-dom': path.resolve(projectRoot, 'react-dom-shim.js'),
  'react-dom/client': path.resolve(projectRoot, 'react-dom-shim.js'),
  '@gettitonline/shared': sharedPackageRoot,
  '@clerk/clerk-expo': resolveWorkspaceModule('@clerk/clerk-expo'),
  '@clerk/clerk-react': resolveWorkspaceModule('@clerk/clerk-react'),
  'react': resolveWorkspaceModule('react'),
  'react-native': resolveWorkspaceModule('react-native'),
};

// 4. Custom resolver to intercept react-dom requests
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Redirect react-dom and its subpaths to our shim
  if (moduleName === 'react-dom' || moduleName.startsWith('react-dom/')) {
    return {
      filePath: path.resolve(projectRoot, 'react-dom-shim.js'),
      type: 'sourceFile',
    };
  }

  // Use the original resolver for everything else
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }

  // Fall back to default resolution
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
