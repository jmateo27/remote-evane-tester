import { Buffer } from 'buffer';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
  View
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

(global as any).Buffer = Buffer;

// Full 128-bit version of 0x181A (Environmental Sensing)
const SERVICE_UUID = '0000181A-0000-1000-8000-00805f9b34fb';
const CHARACTERISTIC_UUID = '2A6E';

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      if (Platform.Version < 31) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission Required',
            message: 'Location permission is needed to scan for BLE devices',
            buttonPositive: 'OK',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
      } else {
        const grantedScan = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          {
            title: 'Bluetooth Scan Permission Required',
            message: 'Bluetooth scan permission is needed to find devices',
            buttonPositive: 'OK',
          }
        );
        const grantedConnect = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          {
            title: 'Bluetooth Connect Permission Required',
            message: 'Bluetooth connect permission is needed to connect to devices',
            buttonPositive: 'OK',
          }
        );
        if (
          grantedScan !== PermissionsAndroid.RESULTS.GRANTED ||
          grantedConnect !== PermissionsAndroid.RESULTS.GRANTED
        )
          return false;
      }
    }
    return true;
  }

  async function startScanAndConnect() {
    const permission = await requestPermissions();
    if (!permission) return;

    setConnecting(true);
    bleManager.stopDeviceScan();

    bleManager.startDeviceScan([SERVICE_UUID], null, async (error, device) => {
      if (error) {
        console.warn('Scan error:', error);
        setConnecting(false);
        return;
      }

      if (device) {
        bleManager.stopDeviceScan();
        try {
          const connected = await device.connect();
          await connected.discoverAllServicesAndCharacteristics();
          setConnectedDevice(connected);
          monitorNotifications(connected);

          connected.onDisconnected(() => {
            ToastAndroid.show('Device disconnected', ToastAndroid.SHORT);
            disconnect();
          });
        } catch (e) {
          console.warn('Connection failed:', e);
          ToastAndroid.show('Connection failed', ToastAndroid.SHORT);
        } finally {
          setConnecting(false);
        }
      }
    });
  }

  function monitorNotifications(device: Device) {
    device.monitorCharacteristicForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('Notification error:', error);
          disconnect();
          return;
        }

        if (characteristic?.value) {
          const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
          const isValid = /^[BV]-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(decoded);
          if (!isValid) {
            console.warn('Invalid format:', decoded);
            return;
          }

          const type = decoded.charAt(0);
          const [firstStr, secondStr] = decoded.slice(1).split(',');
          const firstFloat = parseFloat(firstStr);
          const secondFloat = parseFloat(secondStr);

          if (type === 'B') {
            setBaseline(firstFloat);
            setReading(secondFloat);
            setValue(secondFloat - firstFloat);
          } else if (type === 'V') {
            setVref(firstFloat);
            setReading(secondFloat);
            setValue(Baseline !== null ? secondFloat - Baseline : null);
          }
        }
      }
    );
  }

  async function disconnect() {
    if (connectedDevice) {
      try {
        await connectedDevice.cancelConnection();
      } catch (e) {
        console.warn('Disconnect error:', e);
      }
      setConnectedDevice(null);
      setBaseline(null);
      setVref(null);
      setReading(null);
      setValue(null);
    }
    setTimeout(() => {
      startScanAndConnect();
    }, 500); // debounce reconnect
  }

  useEffect(() => {
    startScanAndConnect();
    return () => {
      bleManager.destroy();
      if (connectedDevice) connectedDevice.cancelConnection();
    };
  }, []);

  return (
    <View style={styles.container}>
      {connecting && (
        <ActivityIndicator size="large" color="#0000ff" style={{ marginBottom: 20 }} />
      )}
      {!connectedDevice ? (
        <Text>Searching for TRANSMITTER...</Text>
      ) : (
        <>
          <Text style={styles.connectedText}>Connected</Text>
          <View style={styles.dataContainer}>
            <Text style={styles.dataText}>
              Baseline: {Baseline !== null ? Baseline.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Vref: {Vref !== null ? Vref.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Reading: {Reading !== null ? Reading.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Value: {Value !== null ? Value.toFixed(6) : '...'}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, marginTop: 40 },
  connectedText: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  dataContainer: {
    marginTop: 20,
    padding: 15,
    borderWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#f9f9f9',
  },
  dataText: { fontSize: 16, marginBottom: 8, fontFamily: 'monospace' },
});
