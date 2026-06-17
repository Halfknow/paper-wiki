module.exports = {
  apps: [{
    name: 'paper-wiki',
    script: 'server.js',
    cwd: __dirname,
    watch: false,                 // 扫描靠定时器；不 watch 避免改 data/ 误重启
    instances: 1,                 // 单实例：保证 JSON 进程内写锁有效
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '512M',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    merge_logs: true,
    time: true,
  }],
};
