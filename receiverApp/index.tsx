import { Buffer } from 'buffer';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { LineChart, Grid, XAxis, YAxis } from 'react-native-svg-charts';
import * as scale from 'd3-scale';
import * as FileSystem from 'expo-file-system';

(global as any).Buffer = Buffer;

const SERVICE_UUID = '181A';
const CHARACTERISTIC_UUID = '2A6E';
const TARGET_NAME = 'TRANSMITTER';
const MAX_GRAPH_SECONDS = 10;

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const baselineRef = useRef<number | null>(null);
  const scanTimerRef = useRef<NodeJS.Timer | null>(null);

  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [scanTime, setScanTime] = useState<number>(0);

  const [graphData, setGraphData] = useState<{ x: number; y: number }[]>([]);
  const maxXRef = useRef(0.5);

  const [isLogging, setIsLogging] = useState(false);
  const [loggingStartTime, setLoggingStartTime] = useState<number | null>(null);
  const [logEntries, setLogEntries] = useState<string[]>([]);

  function updateBaseline(value: number) {
    baselineRef.current = value;
    setBaseline(value);
  }

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      if (Platform.Version < 31) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const grantedScan = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN
        );
        const grantedConnect = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        );
        return (
          grantedScan === PermissionsAndroid.RESULTS.GRANTED &&
          grantedConnect === PermissionsAndroid.RESULTS.GRANTED
        );
      }
    }
    return true;
  }

  async function startScanAndConnect() {
    const permission = await requestPermissions();
    if (!permission) return;

    setScanTime(0);
    setConnecting(true);

    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    scanTimerRef.current = setInterval(() => setScanTime((s) => s + 1), 1000);

    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) {
        bleManager.stopDeviceScan();
        clearInterval(scanTimerRef.current!);
        setConnecting(false);
        return;
      }

      if (device?.name === TARGET_NAME) {
        bleManager.stopDeviceScan();
        clearInterval(scanTimerRef.current!);
        try {
          const connected = await device.connect();
          await connected.discoverAllServicesAndCharacteristics();
          setConnectedDevice(connected);
          monitorNotifications(connected);
          ToastAndroid.show(`Connected in ${scanTime} seconds.`, ToastAndroid.SHORT);
          connected.onDisconnected(disconnect);
        } catch {
          ToastAndroid.show('Connection failed', ToastAndroid.SHORT);
        }
        setConnecting(false);
        setScanTime(0);
      }
    });
  }

  function monitorNotifications(device: Device) {
    device.monitorCharacteristicForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      (_, characteristic) => {
        const decoded = Buffer.from(characteristic?.value ?? '', 'base64').toString('utf-8');
        const match = decoded.match(/^([BV]),(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)$/);
        if (!match) return;

        const type = match[1];
        const first = parseFloat(match[2]);
        const second = parseFloat(match[4]);
        setReading(second);

        if (type === 'B') updateBaseline(first);
        else setVref(first);

        if (baselineRef.current !== null) {
          const value = second - baselineRef.current;
          setValue(value);

          const now = Date.now();
          if (value > maxXRef.current) maxXRef.current = value;
          else maxXRef.current = maxXRef.current * 0.95 + value * 0.05;

          setGraphData((data) => [...data.filter((d) => now - d.timestamp < MAX_GRAPH_SECONDS * 1000), { x: value, y: (now - (data[0]?.timestamp ?? now)) / 1000, timestamp: now }]);

          if (isLogging && loggingStartTime !== null) {
            const timeSinceStart = ((now - loggingStartTime) / 1000).toFixed(3);
            setLogEntries((prev) => [...prev, `${timeSinceStart},${value.toFixed(6)}`]);
          }
        }
      }
    );
  }

  function disconnect() {
    connectedDevice?.cancelConnection();
    setConnectedDevice(null);
    setBaseline(null);
    setVref(null);
    setReading(null);
    setValue(null);
    setConnecting(false);
    setGraphData([]);
    maxXRef.current = 0.5;
    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
  }

  async function startLogging() {
    const now = new Date();
    setLoggingStartTime(now.getTime());
    const dateStr = now.toLocaleDateString().replaceAll('/', '-');
    const timeStr = now.toLocaleTimeString();
    const header = `Date: ${dateStr}\nStart Time: ${timeStr}\nBaseline(V): ${Baseline ?? 'Unknown'}\n\nTime(s),Reading(V)`;
    setLogEntries([header]);
    setIsLogging(true);
  }

  async function stopLogging() {
    setIsLogging(false);
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const logDir = FileSystem.documentDirectory + 'logs/';
    await FileSystem.makeDirectoryAsync(logDir, { intermediates: true });
    let n = 1;
    let fileUri = `${logDir}vaneTestData_${dateStr}_${n}.csv`;
    while (await FileSystem.getInfoAsync(fileUri).then((f) => f.exists)) {
      n++;
      fileUri = `${logDir}vaneTestData_${dateStr}_${n}.csv`;
    }
    await FileSystem.writeAsStringAsync(fileUri, logEntries.join('\n'));
    ToastAndroid.show('CSV file saved', ToastAndroid.SHORT);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Remote Vane Tester</Text>

      {/* Graph UI skipped for brevity, same as before */}

      {connectedDevice && (
        <View style={{ marginTop: 20 }}>
          {!isLogging ? (
            <Button title="Start Logging" onPress={startLogging} />
          ) : (
            <>
              <Button title="Stop Logging" onPress={stopLogging} />
              <Text style={{ marginTop: 10 }}>
                Logging... {((Date.now() - (loggingStartTime ?? 0)) / 1000).toFixed(1)}s
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, marginTop: 40 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
});