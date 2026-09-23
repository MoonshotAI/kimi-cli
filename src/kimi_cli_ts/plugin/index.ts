/**
 * Plugin barrel export — corresponds to Python plugin/__init__.py
 */

export {
	PluginError,
	type PluginRuntime,
	type PluginToolSpec,
	type PluginSpec,
	PLUGIN_JSON,
	parsePluginJson,
	getPluginsDir,
	injectConfig,
	writeRuntime,
	installPlugin,
	refreshPluginConfigs,
	listPlugins,
	removePlugin,
} from "./manager.ts";

export {
	type PluginToolResult,
	type PluginConfig,
	type OAuthManager,
	collectHostValues,
	PluginTool,
	loadPluginTools,
} from "./tool.ts";
