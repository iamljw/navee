#!/usr/bin/env node
'use strict';

const { install, fetch } = require('../lib/nav-command');

require('yargs')
    .command('install', 'install current project to remote repository', install)
    .command('fetch', 'fetch modules of dependencies from repository server', fetch)
    .help('h')
    .alias('h', 'help')
    .argv;
