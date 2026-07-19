// @des DES-F001-017 @fun FUN-F001-033
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => {
  throw new Error('NETWORK_DISABLED_DURING_BUILD');
};

net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
dns.lookup = deny;
dns.resolve = deny;
dns.promises.lookup = deny;
dns.promises.resolve = deny;
dnsPromises.lookup = deny;
dnsPromises.resolve = deny;
syncBuiltinESMExports();
globalThis.fetch = deny;
