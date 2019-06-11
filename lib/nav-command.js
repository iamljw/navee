'use strict';

const http = require('http');
const url = require('url');
const ora = require('ora');
const chalk = require('chalk');
const unzip = require('unzip');
const progress = require('progress-stream');
const fstream = require('fstream');
const fs = require('fs');
const path = require('path');
const co = require('co');
const { exec } = require('child_process');
const archiver = require('archiver')('zip', {
    zlib: { level: 9 }
});
const { EventEmitter } = require('events')
const event = new EventEmitter();
const { log } = console;

/**
 * 项目根路径(当前路径)
 */
const basedir = process.cwd();
/**
 * 模块依赖存放路径
 */
const distdir = path.join(basedir, 'dependencies');
/**
 * 仓库ip、端口
 */
const { repo: { host, port } } = require(path.join(basedir, 'config/config.ncloud'));
/**
 * 拉取模块
 */
function fetch() {
    const start = Date.now();
    co.wrap(_fetch)(basedir, distdir).then(() => {
        const end = Date.now();
        log(chalk.italic(`\n\n成功！耗时${(end - start) / 1000}秒`));
    }).catch(() => {
        log(chalk.red('\n执行过程中发现一些问题，请检查'));
    });
}
/**
 * 从远程/本地仓库拉取依赖的模块
 */
function* _fetch(basedir, distdir) {
    /**
     * 读取配置信息
     */
    const { repo: { host, port }, dependencies } = require(path.join(basedir, 'config/config.ncloud'));
    const pkg = require(path.join(basedir, 'package.json'));
    // 下载
    for (const dependency of dependencies) {
        const { sid, version } = dependency;
        yield _download(pkg, host, port, dependency, basedir, distdir);
        basedir = path.join(basedir, `dependencies/${sid}@${version}`);
        const { dependencies } = require(path.join(basedir, 'config/config.ncloud'));
        if (dependencies && dependencies.length > 0) {
            yield co.wrap(_fetch)(basedir, path.join(basedir, 'dependencies')).catch(() => {
                log(chalk.red('\n执行过程中发现一些问题，请检查'));
            });
        }
    }
    const overWriter = fstream.Writer({ path: path.join(process.cwd(), 'package.json') });
    overWriter.write(JSON.stringify(pkg, null, '  '));
    overWriter.end();
    return;
}
/**
 * 下载
 */
function _download(pkg, host, port, dependency, basedir, distdir) {
    const { sid, version } = dependency;
    return new Promise((resolve, reject) => {
        const spinner = ora({
            prefixText: `${sid}@${version}`,
            text: 'connecting...\n\n',
            spinner: 'balloon'
        });

        // 模块完整信息
        // 目录写入流
        const writer = fstream.Writer({ path: distdir, type: 'Directory' });
        // 监听流关闭信号
        writer.on('close', () => {
            spinner.succeed(chalk.green('下载完毕'));
            resolve();
            const mpkg = require(path.join(basedir, `dependencies/${sid}@${version}/package.json`));
            pkg.dependencies = Object.assign({}, mpkg.dependencies, pkg.dependencies);
        });
        // 格式化请求参数
        const params = url.format({ query: dependency });
        spinner.start();
        http.request({
            host,
            port,
            path: `/download${params}`,
            method: 'HEAD'
        }, res => {
            if (res.statusCode == 200) {
                res.setEncoding(null);
                // 显示传输进度、已下载文件大小、文件总大小、传输速率
                const str = progress({
                    length: res.headers['content-length'],
                    time: 200 /* ms */
                });
                str.on('progress', progress => {
                    // 百分比取整
                    const percentage = Math.round(progress.percentage);
                    // 小数点精确到百分位
                    const transferred = (progress.transferred / 1024 / 1024).toFixed(2);
                    const length = (progress.length / 1024 / 1024).toFixed(2);
                    const speed = (progress.speed / 1024).toFixed(2);
                    spinner.text = `downloading\t${percentage}%\t${transferred}M/${length}M\t${speed}KB/s\n\n`;
                });
                // 拉取
                http.get(`http://${host}:${port}/download${params}`, res => {
                    // 解压目录、写入磁盘
                    res.pipe(str).pipe(unzip.Parse()).pipe(writer);
                });
            } else {
                spinner.fail(chalk.red(res.statusMessage));
                reject();
            }
        }).end();
    });
}
/**
 * 安装
 */
function install() {
    log(chalk.cyan('installing...'));
    // 模块信息
    const { name: sid, version } = require(path.join(process.cwd(), 'package.json'));
    const filename = `${sid}@${version}`;
    // 临时目录
    const tmpdir = `/tmp/ncloud_${Math.random()}`;
    const spinner = ora({
        prefixText: filename,
        text: 'packaging...\n\n',
        spinner: 'balloon'
    }).start();
    // 打包
    _package(filename, tmpdir);
    event.once('packed', () => {
        // 安装
        const source = path.join(tmpdir, filename + '.zip');
        // 输入流
        const reader = fstream.Reader({ path: source });
        // 上传
        // 显示传输进度、已上传文件大小、文件总大小、传输速率
        const str = progress({
            length: reader.length,
            time: 200 /* ms */
        });
        str.on('progress', progress => {
            // 百分比取整
            const percentage = Math.round(progress.percentage);
            // 小数点精确到百分位
            const transferred = (progress.transferred / 1024 / 1024).toFixed(2);
            const length = (progress.length / 1024 / 1024).toFixed(2);
            const speed = (progress.speed / 1024).toFixed(2);
            spinner.text = `installing\t${percentage}%\t${transferred}M/${length}M\t${speed}KB/s\n\n`;
        });
        const params = url.format({ query: { sid, version } });
        const req = http.request({
            host,
            port,
            path: `/installing${params}`,
            method: 'POST',
            headers: {   //请求头
                'Content-Type': 'application/octet-stream',  //数据格式为二进制数据流
                'Transfer-Encoding': 'chunked',  //传输方式为分片传输
                'Connection': 'keep-alive'    //这个比较重要为保持链接。
            }
        });
        reader.pipe(str).pipe(req);
        reader.once('close', () => {
            spinner.succeed(chalk.green('安装完毕'));
            req.end();
        });
    });
}
/**
 * 打包
 */
function _package(filename, tmpdir) {
    fs.mkdirSync(tmpdir);
    // 忽略文件(夹)打包
    exec(`cp ${['-r', basedir, path.join(tmpdir, filename)].join(' ')}`, (error, stdout, stderr) => {
        if (error) throw new Error(error);
        const str = fs.readFileSync('.ignore', 'utf8');
        const ignore = str.split('\n').filter(line => {
            return !(!line || line.startsWith('#'));
        })
            .map(elem => path.join(tmpdir, filename, elem));
        exec(`rm ${['-rf', ...ignore].join(' ')}`, (error, stdout, stderr) => {
            if (error) throw new Error(error);
            // 写入流
            const writer = fstream.Writer({ path: path.join(tmpdir, filename + '.zip') });
            // listen for all archive data to be written
            writer.once('close', function () {
                // log(archiver.pointer()/1024/1024 + 'M');
                // log('压缩完成');
                event.emit('packed');
            });
            // good practice to catch this error explicitly
            archiver.once('error', function (err) {
                throw err;
            });
            archiver.pipe(writer);

            archiver.directory(path.join(tmpdir, filename), filename);
            archiver.finalize();
        });
    });

}

module.exports = {
    install,
    fetch
};
