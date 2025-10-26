module.exports = {
  entry: './src/index.ts',
  mode: 'development',
  target: 'web',
  output: {
    filename: 'index.js',
    path: __dirname + '/dist',
    libraryTarget: 'umd'
  },
  externals: {
    'readline': 'readline',
    'net': 'net',
    'tls': 'tls',
    'fs': 'fs',
    '@yume-chan/adb-server-node-tcp': '@yume-chan/adb-server-node-tcp'
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: [
          /node_modules/,
          /src\/tests/,
          /src\/examples/,
          /src\/adb-daemon-socket\.ts/,
          /src\/node-debug-cli\.ts/,
          /src\/example-.+\.ts/,
          /src\/test-.+\.ts/
        ]
      }
    ]
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  plugins: [
    new webpack.DefinePlugin({
      JDWP_BROWSER_BUILD: 'true'   // Set at build time
    })
  ],
  optimization: {
    usedExports: true,    // Enable tree-shaking
    sideEffects: false
  }
};
