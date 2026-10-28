/** The kit's own archetype plugins, in registration order (a plugin that `requires` another comes after it). */
import feed from "./feed.js";
import chain from "./chain.js";
import timeline from "./timeline.js";
import workflow from "./workflow.js";
import pipeline from "./pipeline.js";
import calculator from "./calculator.js";
import playground from "./playground.js";
import comparison from "./comparison.js";
import roles from "./roles.js";
import screens from "./screens.js";
import machine from "./machine.js";
import runs from "./runs.js";
import notify from "./notify.js";
import tour from "./tour.js";
import workbench from "./workbench.js";
import network from "./network.js";
import flow from "./flow.js";
import builder from "./builder.js";
import match from "./match.js";
import netting from "./netting.js";
import split from "./split.js";

export const KIT_PLUGINS = [feed, chain, timeline, workflow, pipeline, calculator, playground, comparison, roles, screens, machine, runs, notify, tour, workbench, network, flow, split, netting, match, builder];
