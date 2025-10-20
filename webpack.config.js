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
    'fs': 'fs'
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: [
          /node_modules/,
          // /node-debug-cli\.ts/,
          /src\/tests/,
          /src\/examples/
        ]
      }
    ]
  },
  resolve: {
    extensions: ['.ts', '.js']
  }
};
