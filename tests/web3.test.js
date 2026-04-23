const { Web3 } = require('web3');

describe('Web3 BSC Client', () => {
  const bscProvider = 'https://bsc-dataseed1.binance.org:443';
  let web3;

  beforeAll(() => {
    web3 = new Web3(bscProvider);
  });

  describe('Provider initialization', () => {
    test('should create Web3 instance with BSC provider', () => {
      expect(web3).toBeDefined();
      expect(web3.currentProvider).toBeDefined();
    });
  });

  describe('Contract creation', () => {
    const minABI = [
      {
        constant: true,
        inputs: [{ name: '_owner', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: 'balance', type: 'uint256' }],
        type: 'function',
      },
    ];

    test('should create contract instance', () => {
      // BUSD contract on BSC
      const contract = new web3.eth.Contract(minABI, '0xe9e7cea3edca0e12c1e8aec3d0b86d3e0bbdd6a5');
      expect(contract).toBeDefined();
      expect(contract.methods).toBeDefined();
    });

    test('should have balanceOf method', () => {
      const contract = new web3.eth.Contract(minABI, '0xe9e7cea3edca0e12c1e8aec3d0b86d3e0bbdd6a5');
      expect(typeof contract.methods.balanceOf).toBe('function');
    });
  });

  describe('Utility functions', () => {
    test('should convert wei to ether', () => {
      const result = web3.utils.fromWei('1000000000000000000', 'ether');
      expect(result).toBe('1');
    });

    test('should convert ether to wei', () => {
      const result = web3.utils.toWei('1', 'ether');
      expect(result).toBe('1000000000000000000');
    });

    test('should handle decimal values', () => {
      const result = web3.utils.toWei('0.5', 'ether');
      expect(result).toBe('500000000000000000');
    });
  });

  describe('Wallet operations', () => {
    test('should have wallet.add method', () => {
      expect(typeof web3.eth.accounts.wallet.add).toBe('function');
    });

    test('should have wallet.create method', () => {
      expect(typeof web3.eth.accounts.wallet.create).toBe('function');
    });
  });
});

describe('App.js Web3 setup pattern', () => {
test('should create multiple contracts like app.js', () => {
      const web3 = new Web3('https://bsc-dataseed1.binance.org:443');
      const minABI = [
        {
          constant: true,
          inputs: [{ name: '_owner', type: 'address' }],
          name: 'balanceOf',
          outputs: [{ name: 'balance', type: 'uint256' }],
          type: 'function',
        },
      ];

      // Test the pattern used in app.js for creating multiple contracts
      const tokenAddress = '0xe9e7cea3edca0e12c1e8aec3d0b86d3e0bbdd6a5';
      const contract = new web3.eth.Contract(minABI, tokenAddress);

      expect(contract).toBeDefined();
      // Web3 4.x normalizes addresses to mixed case (EIP-55 checksum)
      expect(contract.options.address.toLowerCase()).toBe(tokenAddress.toLowerCase());
    });
});