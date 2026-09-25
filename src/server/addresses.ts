import { BlockList, isIPv4, isIPv6 } from 'node:net';

// Everything that is not a unicast address on the public internet: this network, private
// and shared address space, loopback, link-local, protocol assignments, documentation and
// benchmarking ranges, multicast and the reserved block.
const reservedV4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

// IPv6 is allowed only inside global unicast, less the parts of it that are protocol
// assignments (Teredo among them), documentation, 6to4 relays that tunnel to any IPv4
// address, and segment routing.
const reservedV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', '5f00::/16'];

const reserved = blocks([...reservedV4.map((cidr) => [cidr, 'ipv4'] as const)]);

const global = blocks([['2000::/3', 'ipv6']]);

const reservedGlobal = blocks(reservedV6.map((cidr) => [cidr, 'ipv6'] as const));

// These carry an IPv4 address in their low 32 bits, and are judged by it.
const embedding = blocks([
  ['::ffff:0:0/96', 'ipv6'],
  ['64:ff9b::/96', 'ipv6'],
]);

/** Whether an address is somewhere on the public internet, as opposed to inside a network. */
export function publicAddress(address: string): boolean {
  if (isIPv4(address)) return !reserved.check(address, 'ipv4');

  // A zone only ever scopes a link-local address.
  if (!isIPv6(address) || address.includes('%')) return false;

  if (embedding.check(address, 'ipv6')) return publicAddress(embedded(address));

  return global.check(address, 'ipv6') && !reservedGlobal.check(address, 'ipv6');
}

function blocks(ranges: (readonly [string, 'ipv4' | 'ipv6'])[]): BlockList {
  const list = new BlockList();

  for (const [cidr, family] of ranges) {
    const [base, prefix] = cidr.split('/');

    list.addSubnet(base!, Number(prefix), family);
  }

  return list;
}

/**
 * The IPv4 address in an IPv6 address's low 32 bits. `URL` writes an IPv6 address in its
 * canonical form, where those are always the last two groups, and an empty group is zero.
 */
function embedded(address: string): string {
  const groups = new URL(`http://[${address}]`).hostname.slice(1, -1).split(':').slice(-2);
  const value = groups.reduce((value, group) => value * 65536 + parseInt(group || '0', 16), 0);

  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}
